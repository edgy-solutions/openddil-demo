"""
Test 36 — Prognostics: engine hours (observed-time stand-in).

Scripted-OpenDIS scenario per ADR-0020. Tests the *mechanism* (the engine
extracts a time window from the sample stream and computes hours
correctly), NOT coefficient correctness.

ADR-0020 names engine-hours an explicit overestimate: observed time
counts parked-but-visible time. This test asserts the arithmetic of
observed-time extraction, not that engine-hours is a good model for
real engine-on time.

Scenario:
  Inject ~6 DIS Entity State PDUs for a fresh entity at wall-clock
  spacing of ~0.5s. The engine reads sample_time_ns from the PDU's
  valid_at field (set by the DIS sidecar at ingest). Observed window
  ≈ 5 × 0.5s = 2.5s ≈ 0.00069 hours. Wall-clock jitter widens this to
  a range — assert positive and bounded.
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

NAME = "test_36_prognostics_engine_hours"
DERIVED_TOPIC = "derived-sustainment"
ENGINE_PRESENT_SIGNAL_TOPIC = "openddil-edge-prognostics_accumulators-changelog"
TEST_ENTITY = 9998
SEGMENTS = 5  # six PDUs => five inter-PDU intervals


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

    # Stationary PDUs — kinematic state stays at (0,0,0). The point of this
    # test is the time window; distance and terrain stay 0 deliberately.
    t_start = time.time()
    for _ in range(SEGMENTS + 1):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=TEST_ENTITY,
            kind=1, domain=1, country=225, category=1, subcategory=3,
            specific=1, extra=0,
            marking=f"PROG-{TEST_ENTITY}",
            location_ecef=(0.0, 0.0, 0.0),
            orientation_psi_theta_phi=(0.0, 0.0, 0.0),
        )
        try:
            send_udp_bytes(pdu)
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed: {exc}")
        time.sleep(0.5)
    t_window_s = time.time() - t_start

    time.sleep(5)  # let derivation catch up

    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    raws = consume_topic_binary(DERIVED_TOPIC, n=400, timeout_s=20)
    if not raws:
        fail_(NAME, f"no records on {DERIVED_TOPIC}")

    canonical_id = f"dis:1:1:{TEST_ENTITY}"
    latest = None
    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except Exception:  # noqa: BLE001
            continue
        if evt.asset.asset_id == canonical_id and evt.provenance.source_protocol == "openddil.prognostics.v1":
            latest = evt

    if latest is None:
        fail_(NAME, f"no prognostics events for {canonical_id!r} on {DERIVED_TOPIC}")

    components = latest.sustainment.wear.components
    if "engine" not in components:
        fail_(NAME, "engine wear component missing — observed-time window did not "
                    "register; check the prognostics agent's sample_time_ns "
                    "extraction (valid_at on the proto Position)")
    engine = components["engine"]

    # Natural-unit raw measure: observed hours.
    if engine.hours_in_service.unit != "h":
        fail_(NAME, f"engine.hours_in_service unit is "
                    f"{engine.hours_in_service.unit!r}, expected 'h'")
    hours = engine.hours_in_service.value
    expected_h = t_window_s / 3600.0

    # Wall-clock jitter tolerance: the observed window comes from sidecar
    # ingest timestamps + faust scheduling, not from this test's wall-clock
    # directly. Tolerance of ±50% of expected is loose enough to never flake
    # and tight enough to catch arithmetic errors (e.g. off by 1000×).
    if not (expected_h * 0.5 <= hours <= expected_h * 1.5 + 0.01):
        fail_(NAME, f"engine.hours_in_service={hours:.6f}h is outside the "
                    f"jitter range around expected ~{expected_h:.6f}h "
                    f"(test wall-clock window {t_window_s:.2f}s). Arithmetic "
                    f"off, OR not all PDUs landed in time.")

    # Universal answer: % remaining (engine-life total is 5000 h placeholder,
    # so a ~few-second test should be near 100%).
    if engine.remaining_useful_life.unit != "%":
        fail_(NAME, f"engine.remaining_useful_life unit is "
                    f"{engine.remaining_useful_life.unit!r}, expected '%'")
    if engine.remaining_useful_life.value < 99.0:
        fail_(NAME, f"engine.remaining_useful_life={engine.remaining_useful_life.value} "
                    f"is unexpectedly low (a seconds-scale test should be ~100%)")

    pass_(NAME,
          f"engine-hours observed-time stand-in OK; "
          f"observed={hours:.6f}h (wall-clock window {t_window_s:.2f}s); "
          f"remaining={engine.remaining_useful_life.value:.4f}%; "
          f"provenance=DERIVED")


if __name__ == "__main__":
    main()
