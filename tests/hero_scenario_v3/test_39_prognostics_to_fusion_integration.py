"""
Test 39 — Phase 5 step 2: cross-tying integration.

**THIS IS THE STEP-2 VERIFICATION.** A subscription being registered is
mechanism; an engine-emitted event causing a real downstream artifact is
integration. This test exercises the full path:

    DIS PDU sequence (kinematics + non-zero attitude)
       -> raw-sensor-stream
       -> prognostics_process agent
       -> derived-sustainment
       -> fusion-service Restate subscription `fusion-service-derived`
       -> AssetLogistics/on_derived_sustainment handler (stores state)
       -> _recompute_and_maybe_emit (uses derived as the telemetry fallback
          for a DIS-only asset)
       -> _eval_wear (percent-aware branch on rul.unit == "%"; stamps
          factor.origin from sustainment.value_provenance['*'])
       -> AssetLogisticsStatusUpdate on asset-logistics-status

Assertion: the asset-logistics-status update for the test entity carries
a `wear.suspension` ConstrainingFactor with `origin == ORIGIN_DERIVED`.

Scenario uses the test_37 terrain pattern (pitch=10°, 5×1 km segments →
50 deg·km integral). With the demo-friendly env-override
`PROGNOSTICS_TERRAIN_TOTAL_DEG_KM=50`, that hits 100% consumed → CRITICAL
severity → factor emitted. (With the default 100000 placeholder the
factor would not be emitted; the override is documented in
docker-compose.override.yml.)
"""
from __future__ import annotations

import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    _docker_compose_cmd,
    COMPOSE_DIR,
    REDPANDA_SVC,
    build_entity_state_pdu,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)
from _cm_helpers import consume_asset_logistics_updates  # noqa: E402

NAME = "test_39_prognostics_to_fusion_integration"
LOGISTICS_TOPIC = "asset-logistics-status"
DERIVED_TOPIC = "derived-sustainment"
TEST_ENTITY = 9994
SEGMENT_M = 1000.0
SEGMENTS = 5
PITCH_DEG = 10.0


def _consumer_group_stable(group: str) -> bool:
    """True if `group` exists and its STATE is Stable on the edge-01 broker.
    The integration test gates on this — without the derived-sustainment
    consumer group Stable, the subscription isn't live and the test would
    race fusion's startup. Phase 6b §A made the group names edge-suffixed
    (`fusion-service-derived-edge-01`)."""
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC, "rpk", "group", "describe", group,
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return False
    if proc.returncode != 0:
        return False
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "STATE":
            return parts[1] == "Stable"
    return False


def main() -> None:
    # Readiness gate (Phase 5 readiness-gate principle — see _helpers.py):
    # key on the fusion subscription being Stable, NOT on the eventual
    # asset-logistics-status topic having records for our entity (that
    # would be a result, not readiness).
    if not _consumer_group_stable("fusion-service-derived-edge-01"):
        skip_(NAME, "consumer group `fusion-service-derived-edge-01` not "
                    "Stable — logistics-fusion-service Phase 5 step-2 "
                    "subscription not yet deployed (restart fusion with the "
                    "new register_subscriptions list)")

    pitch_rad = math.radians(PITCH_DEG)
    for i in range(SEGMENTS + 1):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=TEST_ENTITY,
            kind=1, domain=1, country=225, category=1, subcategory=3,
            specific=1, extra=0,
            marking=f"INT-{TEST_ENTITY}",
            location_ecef=(i * SEGMENT_M, 0.0, 0.0),
            orientation_psi_theta_phi=(0.0, pitch_rad, 0.0),
        )
        try:
            send_udp_bytes(pdu)
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed on segment {i}: {exc}")
        time.sleep(0.5)

    # Allow time for: prognostics agent to consume + emit derived events,
    # fusion's Restate subscription to deliver them, AssetLogistics to
    # recompute, and the resulting update to land on asset-logistics-status.
    time.sleep(8)

    canonical_id = f"dis:1:1:{TEST_ENTITY}"

    # asset-logistics-status is a compacted topic; offset-arithmetic-based
    # consumers (rpk consume -o N -n K) hang waiting for compacted-away
    # records. consume_asset_logistics_updates uses confluent_kafka via the
    # OUTSIDE listener and per-partition-tail seeking, which is safe on
    # compacted topics. It also decodes the proto and filters by asset_id.
    updates = consume_asset_logistics_updates(
        asset_id=canonical_id, timeout_s=20, per_partition_tail=200,
    )

    if not updates:
        fail_(NAME, f"no asset-logistics-status updates for {canonical_id} — "
                    f"check that fusion-service-derived consumer group "
                    f"actually received the derived event (rpk group describe "
                    f"fusion-service-derived) and that AssetLogistics's "
                    f"on_derived_sustainment handler ran")

    derived_wear_factor = None
    for upd in updates:
        for f in upd["factors"]:
            if f["factor_id"] == "wear.suspension" and f["origin"] == "ORIGIN_DERIVED":
                derived_wear_factor = f

    if derived_wear_factor is None:
        fail_(NAME, f"got {len(updates)} update(s) for {canonical_id} but "
                    f"none carried a wear.suspension factor with "
                    f"origin=ORIGIN_DERIVED — fusion may have consumed the "
                    f"derived event but the eval_wear percent-aware branch / "
                    f"provenance stamp didn't fire as expected")

    if derived_wear_factor["severity"] not in (
        "LOGISTICS_SEVERITY_DEGRADED", "LOGISTICS_SEVERITY_CRITICAL",
    ):
        fail_(NAME, f"wear.suspension factor severity is "
                    f"{derived_wear_factor['severity']} — expected DEGRADED or "
                    f"CRITICAL given the 50 deg·km integral against the "
                    f"configured terrain coefficient")

    pass_(NAME,
          f"cross-tying integration OK; "
          f"{len(updates)} update(s) for {canonical_id} on "
          f"{LOGISTICS_TOPIC}; wear.suspension factor with "
          f"severity={derived_wear_factor['severity']} "
          f"origin=ORIGIN_DERIVED confidence={derived_wear_factor['confidence']}")


if __name__ == "__main__":
    main()
