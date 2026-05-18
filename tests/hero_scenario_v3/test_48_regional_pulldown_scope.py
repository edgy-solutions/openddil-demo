"""
Test 48 — RegionalApp pulldown scope (ADR-0023 Phase 6c.1).

Verifies that the Regional view's region pulldown actually scopes the
data it shows — selecting region-east shows region-east values, selecting
region-west shows region-west values, no cross-region leakage in either
direction.

The browser-eyeball part of §C.1 (the panels render correctly) is
covered by the §C.1 commit-time checkpoint (load the page, see the
panels). What's NOT eyeball is the queryable claim that the Shape-API
hits for a given ?region= param return data scoped to that region —
that's the same logic the UI panels consume, so a Shape-level
verification is a meaningful regression catch even without driving a
browser.

Pattern (Shape-API-direct, no Playwright dependency):
  - Request the region_fleet_summary shape: returns BOTH region rows
    (unscoped is the right shape for the hook; the React component does
    the .find by selected region client-side).
  - Request the telemetry_latest_state shape with where=region_id=
    'region-east' — should return ONLY edge-01/edge-02 assets.
  - Request the same with where=region_id='region-west' — should
    return ONLY edge-03 assets.
  - POSITIVE per region; NEGATIVE that the OTHER region's assets do
    not appear.

This exercises the SAME `where` clause useFleetAssetsForRegion uses
on the React side; if Shape-side scoping works, the pulldown's user-
visible behavior follows by the same `where`.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import fail_, pass_  # noqa: E402

NAME = "test_48_regional_pulldown_scope"

ELECTRIC_URL = "http://localhost:5133/v1/shape"


def _fetch_shape(table: str, where: str | None = None) -> list[dict]:
    """Fetch one ElectricSQL Shape page; return the parsed row values."""
    q = f"table={table}&offset=-1"
    if where:
        q += f"&where={quote(where)}"
    url = f"{ELECTRIC_URL}?{q}"
    proc = subprocess.run(
        ["curl", "-sS", url],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl failed: {proc.stderr.strip()}")
    body = proc.stdout.strip()
    if not body:
        return []
    payload = json.loads(body)
    rows: list[dict] = []
    for entry in payload:
        if "value" not in entry:
            continue  # skip control entries (snapshot-end, etc.)
        rows.append(entry["value"])
    return rows


def main() -> None:
    # Region rollup table — sanity check both regions are present so the
    # pulldown has options.
    summary = _fetch_shape("region_fleet_summary")
    region_ids = {r.get("region_id") for r in summary}
    if "region-east" not in region_ids or "region-west" not in region_ids:
        fail_(NAME, f"region_fleet_summary missing one of the expected "
                    f"regions; got {sorted(region_ids)}. The pulldown's "
                    f"option list is derived from this shape; missing "
                    f"regions = empty pulldown.")

    # POSITIVE region-east: where-filtered shape returns only east assets.
    east = _fetch_shape("telemetry_latest_state", where="region_id = 'region-east'")
    east_regions = {r.get("region_id") for r in east}
    east_edges = {r.get("edge_id") for r in east}
    if east_regions != {"region-east"}:
        fail_(NAME, f"region-east scope leaked: got region_ids={sorted(east_regions)}. "
                    f"useFleetAssetsForRegion('region-east') would return "
                    f"these wrong rows.")
    if any(e not in {"edge-01", "edge-02"} for e in east_edges if e):
        fail_(NAME, f"region-east scope contains unexpected edges: "
                    f"{sorted(east_edges)}. Expected only edge-01/edge-02.")

    # POSITIVE region-west: where-filtered shape returns only west assets.
    west = _fetch_shape("telemetry_latest_state", where="region_id = 'region-west'")
    west_regions = {r.get("region_id") for r in west}
    west_edges = {r.get("edge_id") for r in west}
    if west_regions != {"region-west"}:
        fail_(NAME, f"region-west scope leaked: got region_ids={sorted(west_regions)}.")
    if any(e not in {"edge-03"} for e in west_edges if e):
        fail_(NAME, f"region-west scope contains unexpected edges: "
                    f"{sorted(west_edges)}. Expected only edge-03.")

    # NEGATIVE: an east asset_id is NOT in the west-scoped shape.
    east_asset_ids = {r.get("asset_id") for r in east}
    west_asset_ids = {r.get("asset_id") for r in west}
    cross_leak = east_asset_ids & west_asset_ids
    if cross_leak:
        fail_(NAME, f"region scopes share asset_ids (impossible — same "
                    f"asset can't be in two regions): {sorted(cross_leak)}.")

    pass_(NAME, f"pulldown scope OK: region-east shape returns "
                f"{len(east)} assets (edges: {sorted(east_edges)}); "
                f"region-west returns {len(west)} assets "
                f"(edges: {sorted(west_edges)}); no cross-region asset_id "
                f"leakage in either direction.")


if __name__ == "__main__":
    main()
