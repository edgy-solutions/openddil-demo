"""
Test 40 — Multi-edge attribution via Provenance message-field (ADR-0023 §6a).

Verifies the end-to-end edge_id field-read path:
    sensor-ingest-NN stamps origin_node in Bronze JSON
      -> redpanda-connect-NN Bloblang preserves to Silver Provenance.edge_id
      -> faust-edge-NN forwards bytes to telemetry-latest-state (per-edge)
      -> projector-NN's telemetry_latest handler reads message-field edge_id
      -> postgres-hq.telemetry_latest_state row carries the real edge_id

Sends one PDU per edge (entities 1500 / 2500 / 3500 to ports 62040 / 62041 /
62042), waits for projection, asserts the per-asset table has 3 rows with
3 distinct edge_id values. This is the 6a observable checkpoint claim —
"per-edge attribution flows through the pipeline end-to-end."
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

NAME = "test_40_multi_edge_attribution"

# One representative entity per edge, in each edge's assigned range.
EDGE_ENTITIES = [
    ("edge-01", "region-east", 1500),
    ("edge-02", "region-east", 2500),
    ("edge-03", "region-west", 3500),
]


def _send_pdu(entity: int, edge_id: str) -> None:
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"INT-{entity}",
        location_ecef=(0.0, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id=edge_id)
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed for entity {entity} on {edge_id}: {exc}")


def main() -> None:
    for edge_id, _region, entity in EDGE_ENTITIES:
        _send_pdu(entity, edge_id)

    # Allow the pipeline a moment: sensor-ingest → Bronze → DIS-mapper →
    # Silver → faust-edge → telemetry-latest-state → projector → postgres.
    time.sleep(6)

    # Pull the rows for our 3 test entities and verify per-edge attribution.
    sql = (
        "SELECT asset_id, edge_id, region_id "
        "FROM telemetry_latest_state "
        "WHERE asset_id IN ('dis:1:1:1500','dis:1:1:2500','dis:1:1:3500') "
        "ORDER BY asset_id"
    )
    rows = query_postgres(sql)
    by_asset = {r[0]: (r[1], r[2]) for r in rows}

    missing = [f"dis:1:1:{e}" for _, _, e in EDGE_ENTITIES
               if f"dis:1:1:{e}" not in by_asset]
    if missing:
        fail_(NAME, f"missing telemetry_latest_state rows for: {missing}; "
                    f"verify all 3 edge stacks are healthy and projector-01/02/03 "
                    f"are consuming")

    wrong = []
    for edge_id, region, entity in EDGE_ENTITIES:
        asset = f"dis:1:1:{entity}"
        actual_edge, actual_region = by_asset[asset]
        if actual_edge != edge_id or actual_region != region:
            wrong.append(
                f"{asset}: expected edge_id={edge_id!r} region_id={region!r}, "
                f"got edge_id={actual_edge!r} region_id={actual_region!r}"
            )

    if wrong:
        fail_(NAME, "per-edge attribution mismatch:\n  " + "\n  ".join(wrong))

    distinct_edges = {by_asset[f"dis:1:1:{e}"][0] for _, _, e in EDGE_ENTITIES}
    if len(distinct_edges) != 3:
        fail_(NAME, f"expected 3 distinct edge_ids in projected rows, got "
                    f"{sorted(distinct_edges)} — projector may be sourcing edge_id "
                    f"from env default instead of message-field Provenance")

    pass_(NAME, f"per-edge attribution OK across {sorted(distinct_edges)}; "
                f"3 entities projected with correct (edge_id, region_id)")


if __name__ == "__main__":
    main()
