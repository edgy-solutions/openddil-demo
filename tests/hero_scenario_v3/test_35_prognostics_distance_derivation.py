"""
Test 35 — Prognostics: distance-driven track wear (scripted OpenDIS scenario).

The scripted-OpenDIS testing model from ADR-0020: known input, known answer,
assert the arithmetic. Tests the *mechanism*, NOT coefficient correctness
(coefficient validation is the deferred AFSIM / VR-Forces phase).

Scenario:
  Inject 6 DIS Entity State PDUs for a fresh entity, stepping the ECEF
  position by 1 km along the X axis between each. Six PDUs → five 1 km
  segments → ~5 km cumulative distance.

Expected on `derived-sustainment`:
  - At least one EntityTelemetryEvent for this entity with
    source_protocol = "openddil.prognostics.v1".
  - The latest such event carries `sustainment.wear.components["track"]`
    with `hours_in_service.value` close to 5.0 (km), unit "km",
    and `remaining_useful_life.value` ≈ track_life_total_km - 5.0.
  - `sustainment.value_provenance["*"].origin` = ORIGIN_DERIVED
    (the Phase 5 message-level wildcard).

Gate: if the `derived-sustainment` topic doesn't exist, SKIP with the
explicit note that the Phase 5 prognostics engine has not yet been
deployed (faust-edge needs a restart with the prognostics package
mounted — see docker-compose.override.yml). This test will pass the
moment that restart happens; no test logic needs to change.
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

NAME = "test_35_prognostics_distance_derivation"
DERIVED_TOPIC = "derived-sustainment"
# The Faust Table's changelog is created at engine startup (when the
# `app.Table` initializes), so its existence on the broker is a reliable
# "engine deployed?" signal. The `derived-sustainment` topic itself only
# auto-creates on the first produce, so checking IT for engine-presence
# would be a chicken-and-egg gate.
ENGINE_PRESENT_SIGNAL_TOPIC = "openddil-edge-prognostics_accumulators-changelog"
TEST_ENTITY = 9999          # unique entity id — avoid noise from other tests
EXPECTED_KM = 5.0           # 5 × 1 km segments
SEGMENT_M = 1000.0
SEGMENTS = 5


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
                    f"deployed (restart faust-edge with the prognostics/ "
                    f"package mounted; see docker-compose.override.yml)")

    # ----- inject a 5 km path: 6 PDUs at 1 km spacing along X (ECEF metres) -----
    # Entity stays the same; only EntityLocation moves. Orientation 0 so
    # the terrain integral stays 0 (we are testing distance, not terrain).
    for i in range(SEGMENTS + 1):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=TEST_ENTITY,
            kind=1, domain=1, country=225, category=1, subcategory=3,
            specific=1, extra=0,
            marking=f"PROG-{TEST_ENTITY}",
            location_ecef=(i * SEGMENT_M, 0.0, 0.0),
            orientation_psi_theta_phi=(0.0, 0.0, 0.0),
        )
        try:
            send_udp_bytes(pdu)
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed on segment {i}: {exc}")
        time.sleep(0.5)  # small spacing so the agent processes them in order

    # ----- wait for derivation, then consume + decode -----
    time.sleep(5)

    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    raws = consume_topic_binary(DERIVED_TOPIC, n=200, timeout_s=20)
    if not raws:
        fail_(NAME, f"no records on {DERIVED_TOPIC} — engine running but "
                    f"produced nothing")

    canonical_id = f"dis:1:1:{TEST_ENTITY}"
    latest = None
    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except Exception:  # noqa: BLE001
            continue
        if evt.asset.asset_id == canonical_id and evt.provenance.source_protocol == "openddil.prognostics.v1":
            latest = evt  # records are read newest-last; keep the last match

    if latest is None:
        fail_(NAME, f"no prognostics events for {canonical_id!r} on "
                    f"{DERIVED_TOPIC} — verify the engine's input agent is "
                    f"consuming raw-sensor-stream and that DIS PDUs for this "
                    f"entity reached Silver")

    # ----- assert the arithmetic -----
    components = latest.sustainment.wear.components
    if "track" not in components:
        fail_(NAME, "track wear component missing on derived event")
    track = components["track"]

    # Natural-unit raw measure: cumulative distance in km.
    cumulative_km = track.hours_in_service.value
    if track.hours_in_service.unit != "km":
        fail_(NAME, f"track.hours_in_service unit is {track.hours_in_service.unit!r}, "
                    f"expected 'km'")
    if not (EXPECTED_KM - 0.01 <= cumulative_km <= EXPECTED_KM + 0.01):
        fail_(NAME, f"cumulative distance {cumulative_km:.4f} km is not within "
                    f"0.01 km of expected {EXPECTED_KM} km — the engine's "
                    f"distance arithmetic is off, OR fewer PDUs landed than "
                    f"expected (check raw-sensor-stream watermark)")

    # Universal answer: remaining_useful_life is percent remaining (unit "%").
    if track.remaining_useful_life.unit != "%":
        fail_(NAME, f"track.remaining_useful_life unit is "
                    f"{track.remaining_useful_life.unit!r}, expected '%'")
    if not (0.0 <= track.remaining_useful_life.value <= 100.0):
        fail_(NAME, f"track.remaining_useful_life={track.remaining_useful_life.value} "
                    f"is outside [0, 100] — percent emit is wrong")

    # Phase 5 message-level provenance wildcard must be set.
    if "*" not in latest.sustainment.value_provenance:
        fail_(NAME, "value_provenance['*'] missing — ADR-0020 message-level "
                    "wildcard not populated")
    from openddil.telemetry.v1 import telemetry_pb2 as pb  # noqa: E402
    vp = latest.sustainment.value_provenance["*"]
    if vp.origin != pb.ORIGIN_DERIVED:
        fail_(NAME, f"value_provenance['*'].origin = {vp.origin}, expected "
                    f"ORIGIN_DERIVED ({pb.ORIGIN_DERIVED})")

    pass_(NAME,
          f"distance-driven track wear OK; "
          f"cumulative_distance={cumulative_km:.4f}km "
          f"(expected ~{EXPECTED_KM}); "
          f"remaining_useful_life={track.remaining_useful_life.value:.1f}{track.remaining_useful_life.unit}; "
          f"status={track.status}; provenance=DERIVED")


if __name__ == "__main__":
    main()
