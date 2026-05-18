"""
Test 47 — region_fleet_summary dual-sum sanity (ADR-0023 Phase 6c.1).

The §C.1 deliverable per recipe tightening 1. Catches the class of bug
the §C.1 rewiring opens up: silent attribution drift between aggregator-
sourced rollups (faust-regional -> region_fleet_summary) and the
underlying flat-pool truth (asset_logistics_status + asset_cm_state).
Same discipline as §A's four SELECT DISTINCT checkpoint — automated
regression that runs every CI.

Three assertions:

  (1) Per-region equality: SUM(asset_count) FROM region_fleet_summary
      WHERE region_id = R must equal COUNT(DISTINCT asset_id) FROM the
      flat-pool union (asset_logistics_status OR asset_cm_state)
      WHERE region_id = R.

  (2) Per-region severity decomposition: nominal + degraded + critical +
      non_operational == asset_count, every row. (Aggregator-by-
      construction guarantee made checkable.)

  (3) Zero region-unspecified rows: region_fleet_summary contains NO
      rows with NULL/empty/'region-unspecified' region_id. Also no
      such rows in the flat-pool tables (the one-time cleanup landed
      pre-§C.1 ship; this assertion enforces the cleanup is permanent).

Stabilization (tightening B): the test does NOT just sleep 65s and hope
for quiescence. It samples region_fleet_summary at T+30s and T+60s; if
the snapshots match exactly, proceed with the dual-sum check. If they
differ (some other test injecting traffic, or aggregator catching up
from a recent burst), wait another 30s and resample. Max 3 cycles; if
quiescence doesn't reach within ~3 minutes, fail with a clear
"unable to reach quiescent state" message rather than running the
dual-sum check on in-flight state.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import fail_, pass_, query_postgres  # noqa: E402

NAME = "test_47_dual_sum_sanity"


def _snapshot_summary() -> dict[str, dict[str, int]]:
    """Snapshot region_fleet_summary as {region_id: {col: int}}."""
    rows = query_postgres(
        "SELECT region_id, nominal, degraded, critical, non_operational, "
        "asset_count FROM region_fleet_summary ORDER BY region_id"
    )
    out: dict[str, dict[str, int]] = {}
    for row in rows:
        rid, nom, deg, crit, no, ac = row
        out[rid] = {
            "nominal":         int(nom),
            "degraded":        int(deg),
            "critical":        int(crit),
            "non_operational": int(no),
            "asset_count":     int(ac),
        }
    return out


def _flat_pool_per_region() -> dict[str, int]:
    """COUNT(DISTINCT asset_id) per region across the flat-pool tables.
    Union of asset_logistics_status and asset_cm_state so any asset seen
    by either pipeline counts once."""
    rows = query_postgres(
        "WITH u AS ("
        "  SELECT DISTINCT asset_id, region_id FROM asset_logistics_status"
        "  UNION"
        "  SELECT DISTINCT asset_id, region_id FROM asset_cm_state"
        ") "
        "SELECT region_id, COUNT(DISTINCT asset_id) FROM u "
        "WHERE region_id IS NOT NULL AND region_id != '' "
        "  AND region_id != 'region-unspecified' "
        "GROUP BY region_id ORDER BY region_id"
    )
    return {row[0]: int(row[1]) for row in rows}


def _wait_for_quiescence(max_cycles: int = 3, cycle_s: int = 30) -> None:
    """Sample region_fleet_summary every cycle_s seconds; return when two
    consecutive snapshots match exactly. Fail if not within max_cycles."""
    print(f"[{NAME}] waiting {cycle_s}s for first sample…", flush=True)
    time.sleep(cycle_s)
    prev = _snapshot_summary()
    for cycle in range(max_cycles):
        print(f"[{NAME}] cycle {cycle+1}/{max_cycles}: waiting {cycle_s}s for resample…", flush=True)
        time.sleep(cycle_s)
        cur = _snapshot_summary()
        if cur == prev:
            print(f"[{NAME}] quiescent at cycle {cycle+1}", flush=True)
            return
        prev = cur
    fail_(NAME, f"unable to reach quiescent state in {max_cycles} cycles "
                f"of {cycle_s}s — another test is likely injecting traffic "
                f"in parallel, or aggregator is genuinely behind. Last "
                f"snapshot: {prev}")


def main() -> None:
    # (3) No region-unspecified rows anywhere. Runs FIRST so the cleanup-
    # is-permanent invariant is enforced before the dual-sum even starts.
    summary_unspecified = query_postgres(
        "SELECT COUNT(*) FROM region_fleet_summary WHERE region_id IS NULL "
        "OR region_id = '' OR region_id = 'region-unspecified'"
    )
    if summary_unspecified and int(summary_unspecified[0][0]) > 0:
        fail_(NAME, f"region_fleet_summary contains "
                    f"{summary_unspecified[0][0]} unspecified rows — "
                    f"aggregator should never emit them; deployment-time "
                    f"contract violation or upstream bug.")

    for tbl in ("asset_cm_state", "asset_logistics_status"):
        rows = query_postgres(
            f"SELECT COUNT(*) FROM {tbl} WHERE region_id IS NULL "
            f"OR region_id = '' OR region_id = 'region-unspecified'"
        )
        n = int(rows[0][0]) if rows else 0
        if n > 0:
            fail_(NAME, f"{tbl} has {n} unspecified region_id rows — "
                        f"pre-§C.1 cleanup did not stick. See follow-up "
                        f"#14; may need another refresh-PDU pass for any "
                        f"newly-stale assets.")

    # Stabilization (tightening B).
    _wait_for_quiescence()

    summary = _snapshot_summary()
    if not summary:
        fail_(NAME, "region_fleet_summary is empty — faust-regional not "
                    "emitting. Are the regional services running?")

    flat = _flat_pool_per_region()

    # (1) Per-region equality.
    summary_regions = set(summary.keys())
    flat_regions = set(flat.keys())
    if summary_regions != flat_regions:
        fail_(NAME, f"region set mismatch — summary={sorted(summary_regions)} "
                    f"flat={sorted(flat_regions)}. Either aggregator missed "
                    f"a region or flat-pool has phantom assets.")

    mismatches: list[str] = []
    for region in sorted(summary_regions):
        agg_count = summary[region]["asset_count"]
        flat_count = flat[region]
        if agg_count != flat_count:
            mismatches.append(
                f"{region}: summary={agg_count} flat={flat_count} "
                f"(delta={agg_count - flat_count})"
            )
    if mismatches:
        fail_(NAME, "per-region asset_count drift between aggregator and "
                    "flat-pool: " + "; ".join(mismatches))

    # (2) Per-region severity decomposition.
    for region, row in summary.items():
        bucket_sum = row["nominal"] + row["degraded"] + row["critical"] + row["non_operational"]
        if bucket_sum != row["asset_count"]:
            fail_(NAME, f"{region}: severity buckets sum to {bucket_sum} "
                        f"but asset_count={row['asset_count']}. Aggregator "
                        f"miscount — bucket-assignment in faust-regional "
                        f"severity.py is wrong, or a bucket name typo.")

    pass_(NAME, f"dual-sum OK across {len(summary)} regions; "
                f"every region's asset_count matches flat-pool exactly; "
                f"severity buckets sum to asset_count per region; "
                f"zero region-unspecified rows anywhere.")


if __name__ == "__main__":
    main()
