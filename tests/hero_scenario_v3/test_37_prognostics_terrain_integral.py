"""
Test 37 — Prognostics: terrain-integral suspension stress.

Scripted-OpenDIS scenario per ADR-0020. Tests the *mechanism* (the engine
integrates |pitch|+|roll| over distance correctly), NOT coefficient
correctness.

Scenario:
  Inject 6 DIS Entity State PDUs along the X axis, 1 km apart, with a
  constant pitch of 10° (passed in radians on the DIS wire — sim-dis-
  mapping.yaml preserves the unit; the engine converts rad → deg in
  `_extract_kinematic`). Roll stays 0.

  Trapezoidal integral per segment:
    avg(|pitch|) = (10 + 10)/2 = 10°, avg(|roll|) = 0, sum = 10°
    × segment length 1 km = 10 deg·km per segment
    × 5 segments  = 50 deg·km cumulative

Expected on `derived-sustainment`:
  - `wear.suspension.hours_in_service` ≈ 50 deg·km (unit "deg.km")
  - `wear.suspension.remaining_useful_life` is a percent (unit "%")
"""
from __future__ import annotations

import math
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

NAME = "test_37_prognostics_terrain_integral"
DERIVED_TOPIC = "derived-sustainment"
ENGINE_PRESENT_SIGNAL_TOPIC = "openddil-edge-prognostics_accumulators-changelog"
TEST_ENTITY = 9997
SEGMENT_M = 1000.0
SEGMENTS = 5
PITCH_DEG = 10.0
EXPECTED_DEG_KM = PITCH_DEG * (SEGMENT_M / 1000.0) * SEGMENTS  # 50.0


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

    pitch_rad = math.radians(PITCH_DEG)
    for i in range(SEGMENTS + 1):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=TEST_ENTITY,
            kind=1, domain=1, country=225, category=1, subcategory=3,
            specific=1, extra=0,
            marking=f"PROG-{TEST_ENTITY}",
            location_ecef=(i * SEGMENT_M, 0.0, 0.0),
            # DIS Entity State PDU orientation is on-the-wire radians;
            # tuple order is (psi, theta, phi) = (yaw, pitch, roll).
            orientation_psi_theta_phi=(0.0, pitch_rad, 0.0),
        )
        try:
            send_udp_bytes(pdu)
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed on segment {i}: {exc}")
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
    if "suspension" not in components:
        fail_(NAME, "suspension wear missing — terrain integration did not run; "
                    "check that the agent extracted attitude (rad→deg) from "
                    "the DIS attitude block correctly")
    susp = components["suspension"]

    if susp.hours_in_service.unit != "deg.km":
        fail_(NAME, f"suspension.hours_in_service unit is "
                    f"{susp.hours_in_service.unit!r}, expected 'deg.km'")
    integral = susp.hours_in_service.value
    # Tight tolerance — the arithmetic is exact-to-float; allow 0.5 deg·km
    # slack for DIS-orientation float32 rad→deg round-trip jitter.
    if not (EXPECTED_DEG_KM - 0.5 <= integral <= EXPECTED_DEG_KM + 0.5):
        fail_(NAME, f"terrain integral {integral:.4f} deg·km is not within "
                    f"0.5 of expected {EXPECTED_DEG_KM} — arithmetic off, OR "
                    f"attitude conversion is producing a different value")

    if susp.remaining_useful_life.unit != "%":
        fail_(NAME, f"suspension.remaining_useful_life unit is "
                    f"{susp.remaining_useful_life.unit!r}, expected '%'")
    if not (0.0 <= susp.remaining_useful_life.value <= 100.0):
        fail_(NAME, f"suspension.remaining_useful_life={susp.remaining_useful_life.value} "
                    f"is outside [0, 100]")

    pass_(NAME,
          f"terrain-integral suspension OK; "
          f"integral={integral:.4f} deg·km "
          f"(expected ~{EXPECTED_DEG_KM}); "
          f"remaining={susp.remaining_useful_life.value:.4f}%; "
          f"provenance=DERIVED")


if __name__ == "__main__":
    main()
