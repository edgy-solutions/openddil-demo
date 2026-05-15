"""
Test 38 — Prognostics: barrel-life is built but DORMANT pending
Fire/Detonation PDU ingestion.

Per ADR-0020, the barrel-life model has the shape and passes unit tests,
but emits nothing in practice because Fire/Detonation PDU ingestion is
a follow-on wiring step (tracked follow-up #4) — the prognostics
accumulator's `rounds_fired` never advances above 0, so
`_derive_barrel_life` correctly returns None.

This test asserts the DORMANCY explicitly — `wear.barrel` must be
ABSENT from every derived event for the test entity. Two reasons for
positive-absence vs. skip-entirely:
  1. **Visibility.** A run-of-the-suite reports PASS for this test on
     every run, so the dormancy is announced — it doesn't fade into "we
     don't talk about that test." Same discipline as ADR-0020's
     "Methodology placeholders to name out loud."
  2. **Regression guard.** If something accidentally starts emitting
     `wear.barrel` before Fire/Detonation is properly wired (e.g. someone
     stubs in a constant in the model), this test fails loudly. A
     skip-entirely test would let that slip through silently.

When Fire/Detonation PDU ingestion lands, **the test inverts** —
flip the assertion from "barrel not in components" to "barrel in
components, cycles > 0, remaining_useful_life unit '%'", and remove
this dormancy framing.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    _docker_compose_cmd,
    COMPOSE_DIR,
    REDPANDA_SVC,
    build_entity_state_pdu,
    consume_topic_binary,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

NAME = "test_38_prognostics_barrel_life_dormant"
DERIVED_TOPIC = "derived-sustainment"
ENGINE_PRESENT_SIGNAL_TOPIC = "openddil-edge-prognostics_accumulators-changelog"
TEST_ENTITY = 9996


def _topic_present(topic: str) -> bool:
    import subprocess
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC, "rpk", "topic", "list",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return False
    if proc.returncode != 0:
        return False
    return any(line.split()[0:1] == [topic]
               for line in proc.stdout.splitlines() if line.strip())


def main() -> None:
    if not _topic_present(ENGINE_PRESENT_SIGNAL_TOPIC):
        skip_(NAME, f"engine-present signal topic {ENGINE_PRESENT_SIGNAL_TOPIC!r} "
                    f"not on the broker — Phase 5 prognostics engine not yet "
                    f"deployed")

    # Send a few PDUs so the engine has accumulator state for this entity.
    # The PDUs do not need any "fire-y" content — Fire/Detonation PDUs are a
    # separate PDU type (not Entity State) and aren't wired into the engine
    # input path; this test specifically establishes that `wear.barrel` is
    # absent given only Entity State input.
    for i in range(3):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=TEST_ENTITY,
            marking=f"PROG-{TEST_ENTITY}",
            location_ecef=(i * 500.0, 0.0, 0.0),
            orientation_psi_theta_phi=(0.0, 0.0, 0.0),
        )
        try:
            send_udp_bytes(pdu)
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed: {exc}")
        time.sleep(0.5)

    time.sleep(5)

    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    raws = consume_topic_binary(DERIVED_TOPIC, n=400, timeout_s=20)
    if not raws:
        fail_(NAME, f"no records on {DERIVED_TOPIC}")

    canonical_id = f"dis:1:1:{TEST_ENTITY}"
    events_for_entity = []
    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except Exception:  # noqa: BLE001
            continue
        if evt.asset.asset_id == canonical_id and evt.provenance.source_protocol == "openddil.prognostics.v1":
            events_for_entity.append(evt)

    if not events_for_entity:
        fail_(NAME, f"no prognostics events for {canonical_id!r} on {DERIVED_TOPIC}")

    # The dormancy assertion: NO event for this entity carries `wear.barrel`.
    # When Fire/Detonation PDU ingestion lands (tracked follow-up #4), invert
    # this — assert barrel IS present, cycles > 0, remaining_useful_life
    # unit '%'. The negative form catches a "someone stubbed a default"
    # regression that a skip-entirely test would miss.
    for evt in events_for_entity:
        if "barrel" in evt.sustainment.wear.components:
            ws = evt.sustainment.wear.components["barrel"]
            fail_(NAME, f"wear.barrel UNEXPECTEDLY present on derived event for "
                        f"{canonical_id}: cycles={ws.cycles.value}, "
                        f"rul={ws.remaining_useful_life.value}. Fire/Detonation "
                        f"PDU ingestion is the only legitimate way to surface "
                        f"this — confirm follow-up #4 actually landed before "
                        f"inverting this test.")

    pass_(NAME,
          f"barrel-life DORMANT (Fire/Detonation PDU ingestion not wired — "
          f"follow-up #4); confirmed absent from "
          f"{len(events_for_entity)} derived events for {canonical_id}")


if __name__ == "__main__":
    main()
