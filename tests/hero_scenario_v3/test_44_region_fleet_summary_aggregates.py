"""
Test 44 — region-fleet-summary aggregation correctness (ADR-0023 §B).

Verifies that faust-regional's aggregator does REAL streaming work —
flipping an asset's severity in a region drives the region's bucket
counts to change at the next heartbeat. This is the ADR-0023 constraint-3
verification on the wire ("streaming aggregation does real work in
faust-regional"); the pass/fail of this test is the §B observable
checkpoint's bottom-line claim.

Pattern:
  - Snapshot region_fleet_summary BEFORE.
  - Send a fresh entity (never seen) to region-east via edge-02. Fresh
    entities get cm-state initialized at CONFIG_STATUS_NOT_MISSION_CAPABLE
    immediately (M1A2-SEPv3-Baseline-2024.2 has 2 overdue mods), so the
    fresh asset enters the non_operational bucket.
  - Wait for the next aggregator heartbeat (30s interval; wait 35s).
  - Snapshot AFTER. region-east.asset_count and non_operational both
    increment by exactly 1; region-west is unchanged.

Negative assertion: region-west's row is unchanged (the fresh asset on
edge-02 does NOT leak into region-west's counts).

Defines the headline observable claim of §B in test form.
"""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    build_entity_state_pdu,
    fail_,
    pass_,
    query_postgres,
    send_udp_bytes,
)

NAME = "test_44_region_fleet_summary_aggregates"


def _snapshot() -> dict[str, dict[str, int]]:
    """Snapshot all region_fleet_summary rows as {region_id: {column: int}}."""
    rows = query_postgres(
        "SELECT region_id, nominal, degraded, critical, non_operational, "
        "asset_count FROM region_fleet_summary ORDER BY region_id"
    )
    out = {}
    for row in rows:
        region_id, nominal, degraded, critical, non_op, asset_count = row
        out[region_id] = {
            "nominal":         int(nominal),
            "degraded":        int(degraded),
            "critical":        int(critical),
            "non_operational": int(non_op),
            "asset_count":     int(asset_count),
        }
    return out


def main() -> None:
    before = _snapshot()
    if "region-east" not in before:
        fail_(NAME, "region_fleet_summary has no region-east row before test "
                    "starts — faust-regional-east not emitting? Run test_43 "
                    "first to verify multi-cluster consumption works.")

    # Use a per-run unique entity in edge-02's range. The aggregator's
    # assets_latest Table is durable across test runs (changelog-replicated
    # RocksDB), so a fixed entity_id would re-UPSERT and produce delta=0
    # on the second run. Bottom 3 digits of unix time keep IDs unique
    # within the edge-02 (2NNN) range and avoid collisions with test_46.
    fresh_entity = 2000 + (int(time.time()) % 800) + 100  # 2100-2899 range
    asset_id = f"dis:1:1:{fresh_entity}"

    pdu = build_entity_state_pdu(
        site=1, application=1, entity=fresh_entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"AGG-{fresh_entity}",
        location_ecef=(0.0, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id="edge-02")
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed: {exc}")

    # Wait long enough for: (sensor-ingest+dis-mapper+faust-edge) ->
    # raw-sensor-stream -> (cm-service via Restate) -> asset-cm-state
    # (NMC initialization) -> faust-regional source App -> region-east-
    # fan-in -> aggregator updates assets_latest Table -> heartbeat fires
    # -> region-fleet-summary emit -> projector-hq UPSERTs the table.
    # Aggregator heartbeat is 30s; one full cycle + slack.
    time.sleep(38)

    after = _snapshot()

    east_before = before["region-east"]
    east_after = after.get("region-east")
    if east_after is None:
        fail_(NAME, "region-east row disappeared during test — aggregator emit failed")

    # POSITIVE: region-east asset_count increased by 1, non_operational also
    # increased by 1 (fresh M1A2-SEPv3 is NMC at initialization due to overdue mods).
    delta_count = east_after["asset_count"] - east_before["asset_count"]
    delta_nmc = east_after["non_operational"] - east_before["non_operational"]
    if delta_count != 1:
        fail_(NAME, f"region-east.asset_count delta={delta_count} (expected 1). "
                    f"before={east_before} after={east_after}. Aggregator "
                    f"didn't pick up the fresh asset.")
    if delta_nmc != 1:
        fail_(NAME, f"region-east.non_operational delta={delta_nmc} (expected 1). "
                    f"before={east_before} after={east_after}. Fresh M1A2-SEPv3 "
                    f"should be NMC at initialization (overdue mods); aggregator "
                    f"placed it in wrong bucket.")

    # NEGATIVE: region-west is unchanged (no cross-region leakage).
    west_before = before.get("region-west", {})
    west_after = after.get("region-west", {})
    for col in ("asset_count", "non_operational", "critical", "degraded", "nominal"):
        if west_before.get(col, 0) != west_after.get(col, 0):
            fail_(NAME, f"region-west.{col} changed (before={west_before.get(col)} "
                        f"after={west_after.get(col)}) — fresh asset on edge-02 "
                        f"(region-east) leaked into region-west's counts.")

    pass_(NAME, f"aggregation OK: region-east asset_count and "
                f"non_operational both incremented by 1 (before "
                f"asset_count={east_before['asset_count']}, after "
                f"asset_count={east_after['asset_count']}); region-west "
                f"unchanged (no cross-region leakage)")


if __name__ == "__main__":
    main()
