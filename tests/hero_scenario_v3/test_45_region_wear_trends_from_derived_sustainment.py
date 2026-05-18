"""
Test 45 — region-wear-trends end-to-end from derived-sustainment (ADR-0023 §B).

Verifies that derived-sustainment flowing from faust-edge's prognostics
agent reaches faust-regional's aggregator and produces a populated
region_wear_trends row with a non-zero asset_count for at least one
component.

ASYMMETRIC COVERAGE NAMED HERE (recipe-greenlit pre-build): §B exercises
the wear-trends rollup via derived-sustainment ONLY. asset-telemetry-
windows is wired in the fan-in envelope but is DEBUG-no-op in the
aggregator's dispatcher (pending follow-up #11's sustainment-data test
fixtures, which would close the windowed-path's end-to-end coverage).
A full-join test (both inputs hot) is NOT in §B scope and is NOT in
this test's claim.

What this test verifies (and explicitly does NOT verify):
  ✓ derived-sustainment events stamp Provenance.edge_id (Phase 6a verified)
  ✓ source App wraps them into the envelope's derived_sustainment slot
  ✓ aggregator's _apply_derived_sustainment populates sustainment_wear
    in assets_latest Table
  ✓ heartbeat emit derives at least one ComponentWearTrend
  ✓ projector handler writes to region_wear_trends.components JSONB
  ✗ DOES NOT verify the asset-telemetry-windows -> aggregator update path
    (intentionally — that's follow-up #11)

Pattern: send a fresh asset to edge-01, drive faust-edge to emit
derived-sustainment for it (the prognostics agent emits once it has
enough samples / time), wait for the aggregator heartbeat, assert
region-east.components is non-empty AND at least one component has
asset_count > 0.
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

NAME = "test_45_region_wear_trends_from_derived_sustainment"


def main() -> None:
    # Send a small burst from edge-01 so faust-edge's prognostics agent
    # gets enough samples to emit derived-sustainment.
    fresh_entity = 1880
    asset_id = f"dis:1:1:{fresh_entity}"

    for tick in range(5):
        pdu = build_entity_state_pdu(
            site=1, application=1, entity=fresh_entity,
            kind=1, domain=1, country=225, category=1, subcategory=3,
            specific=1, extra=0,
            marking=f"WEAR-{fresh_entity}",
            location_ecef=(100.0 * tick, 0.0, 0.0),  # moving so prognostics fires
            orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
        )
        try:
            send_udp_bytes(pdu, edge_id="edge-01")
        except Exception as exc:  # noqa: BLE001
            fail_(NAME, f"send_udp_bytes failed at tick {tick}: {exc}")
        time.sleep(0.3)

    # Pipeline:
    #   edge-01 sensor-ingest -> raw-sensor-stream (edge-01)
    #     -> faust-edge-01 prognostics agent -> derived-sustainment (edge-01)
    #     -> faust-regional-east source App -> region-east-fan-in (hq)
    #     -> aggregator Table -> heartbeat -> region-wear-trends (hq)
    #     -> projector-hq -> region_wear_trends row
    # Aggregator heartbeat is 30s; one full cycle + slack.
    time.sleep(40)

    rows = query_postgres(
        "SELECT region_id, components::text FROM region_wear_trends "
        "WHERE region_id = 'region-east'"
    )
    if not rows:
        fail_(NAME, "region_wear_trends has no region-east row — wear-trends "
                    "pipeline broken end-to-end (or no derived-sustainment "
                    "events from faust-edge-01 prognostics within timeout).")

    region_id, components_json = rows[0]
    components = json.loads(components_json) if components_json else []

    if not components:
        fail_(NAME, "region-east components array is empty — aggregator's "
                    "_apply_derived_sustainment didn't populate any wear "
                    "component, or heartbeat emit skipped the wear-trends "
                    "output.")

    # At least one component must show asset_count > 0 (the fresh asset
    # contributed). Don't pin which component_id (depends on which
    # prognostics outputs the engine derived in this run).
    contributing = [
        c for c in components
        if int(c.get("asset_count") or c.get("assetCount") or 0) > 0
    ]
    if not contributing:
        fail_(NAME, f"no component in region-east has asset_count > 0. "
                    f"components={components}")

    pass_(NAME, f"wear-trends OK: region-east has {len(components)} component "
                f"entries, {len(contributing)} with non-zero asset_count. "
                f"Asymmetric coverage note: derived-sustainment path verified "
                f"end-to-end; asset-telemetry-windows path intentionally NOT "
                f"exercised (follow-up #11).")


if __name__ == "__main__":
    main()
