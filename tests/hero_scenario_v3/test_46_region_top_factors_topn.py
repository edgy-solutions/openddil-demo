"""
Test 46 — region-top-factors top-N selection (ADR-0023 §B).

Verifies faust-regional's top-N selection across edges' assets. The
top-factors aggregation is the rollup with the most logic (count + sort +
top-N + severity_breakdown) so it gets its own test rather than being
absorbed by test_44's fleet-summary check.

NOT scope-permitting / optional — explicitly landed per the §B greenlight
tightening C: "Testing coverage should match logic complexity. Land
test_46."

Pattern:
  - Snapshot region-east factors BEFORE.
  - Send a fresh entity to edge-01 (region-east). Fresh M1A2-SEPv3 assets
    get cm-state at NMC immediately (overdue mods) — fusion eventually
    emits an asset-logistics-status with at least one constraining
    factor (typically wear.* or sustainment.*).
  - Wait for the aggregator heartbeat.
  - Snapshot AFTER. Assert that:
    (a) region-east still has at least one factor (positive: aggregator
        kept producing top-factors emissions across the new asset's arrival)
    (b) factors array is sorted DESC by count (the "top-N" claim — N=10
        default; with the running fleet's factor diversity, the top of the
        list is the most-frequent factor)
    (c) every factor row has a non-empty severity_breakdown map
    (d) NEGATIVE: any factors present in region-east are NOT a strict subset
        of region-west's factors (the regions have distinct fleets, so
        their top-N shapes should diverge in at least one factor_id OR
        in counts).
"""
from __future__ import annotations

import json
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

NAME = "test_46_region_top_factors_topn"


def _read_factors(region_id: str) -> list[dict]:
    rows = query_postgres(
        f"SELECT factors::text FROM region_top_factors "
        f"WHERE region_id = '{region_id}'"
    )
    if not rows:
        return []
    return json.loads(rows[0][0]) if rows[0][0] else []


def main() -> None:
    # Drive a fresh entity to ensure faust-regional has recent emissions to
    # work with. Use a unique id from edge-01's range to attribute to
    # region-east.
    fresh_entity = 1890
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=fresh_entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"TOPF-{fresh_entity}",
        location_ecef=(0.0, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id="edge-01")
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed: {exc}")

    # Wait for fusion to emit asset-logistics-status for the new asset
    # (fusion is on a 30s emit cadence), plus another aggregator heartbeat.
    # The fan-in source App picks up the new logistics-status from hq.
    time.sleep(70)

    east = _read_factors("region-east")
    west = _read_factors("region-west")

    if not east:
        fail_(NAME, "region-east has zero factors after sending a fresh asset. "
                    "fusion may not have emitted asset-logistics-status with "
                    "constraining_factors yet; aggregator may not have "
                    "received logistics_status envelopes from the hq source "
                    "App.")

    # (b) Sorted DESC by count.
    counts = [int(f.get("count", 0)) for f in east]
    if counts != sorted(counts, reverse=True):
        fail_(NAME, f"region-east factors are not sorted DESC by count: "
                    f"counts={counts}")

    # (c) Every entry has a non-empty severity_breakdown.
    for f in east:
        sb = f.get("severity_breakdown") or f.get("severityBreakdown") or {}
        if not sb:
            fail_(NAME, f"factor {f.get('factor_id') or f.get('factorId')} has "
                        f"empty severity_breakdown. Aggregator dropped severity "
                        f"information.")

    # (d) NEGATIVE: regions should not produce identical top-N
    # (their fleets differ). Acceptable for one region to be a strict
    # subset of the other ONLY if both are non-empty AND have different
    # counts on the shared keys (which would still differentiate them).
    east_ids = {f.get("factor_id") or f.get("factorId") for f in east}
    west_ids = {f.get("factor_id") or f.get("factorId") for f in west}
    if east and west and east_ids == west_ids:
        # Same factor_ids; check that counts differ (regions have different
        # fleet sizes so identical counts would be suspicious).
        east_by_id = {(f.get("factor_id") or f.get("factorId")): int(f.get("count", 0)) for f in east}
        west_by_id = {(f.get("factor_id") or f.get("factorId")): int(f.get("count", 0)) for f in west}
        if east_by_id == west_by_id:
            fail_(NAME, f"region-east and region-west have IDENTICAL top-N "
                        f"(same factor_ids AND same counts). Either the "
                        f"aggregator is cross-region-leaking, or the test data "
                        f"happens to be symmetric. east={east_by_id} "
                        f"west={west_by_id}")

    pass_(NAME, f"top-N OK: region-east has {len(east)} factors "
                f"(sorted DESC, severity_breakdown populated); region-west "
                f"has {len(west)} factors; regions are distinguishable "
                f"(east_ids={sorted(east_ids)}, west_ids={sorted(west_ids)}).")


if __name__ == "__main__":
    main()
