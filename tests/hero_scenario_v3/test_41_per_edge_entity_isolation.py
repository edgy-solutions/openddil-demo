"""
Test 41 — Per-edge entity isolation (ADR-0023 §6a, positive + negative).

Test 40 verifies the happy path: each edge's PDUs project with the right
edge_id. Test 41 verifies the *isolation* property: an entity sent to one
edge does NOT appear with a different edge's attribution. That's the
deployment-time contract from ADR-0023 §Topology made testable: distinct
OPENDDIL_EDGE_ID per edge stack + test-side discipline on entity ranges
+ no cross-edge data leakage.

Pattern: positive assertion (entity X projects with edge_id Y) AND
negative assertion (entity X does NOT project with any other edge_id).
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

NAME = "test_41_per_edge_entity_isolation"

# Use entities in different ranges to make the isolation check unambiguous.
TEST_PAIRS = [
    ("edge-01", 1750),  # edge-01 range
    ("edge-02", 2750),  # edge-02 range
]


def _send_pdu(entity: int, edge_id: str) -> None:
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"ISO-{entity}",
        location_ecef=(0.0, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id=edge_id)
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed for entity {entity} on {edge_id}: {exc}")


def main() -> None:
    for edge_id, entity in TEST_PAIRS:
        _send_pdu(entity, edge_id)

    time.sleep(6)

    asset_ids = [f"dis:1:1:{e}" for _, e in TEST_PAIRS]
    sql = (
        "SELECT asset_id, edge_id FROM telemetry_latest_state "
        f"WHERE asset_id IN ({','.join(repr(a) for a in asset_ids)}) "
        "ORDER BY asset_id"
    )
    rows = query_postgres(sql)
    # Build full {asset_id: set(edge_ids_seen)} — multiple rows per asset
    # would itself be a UPSERT-key violation, but if it ever happens the
    # set-collection surfaces it.
    seen: dict[str, set[str]] = {}
    for r in rows:
        seen.setdefault(r[0], set()).add(r[1])

    failures: list[str] = []
    for edge_id, entity in TEST_PAIRS:
        asset = f"dis:1:1:{entity}"
        observed = seen.get(asset, set())

        # Positive: asset must appear with its assigned edge_id.
        if edge_id not in observed:
            failures.append(
                f"{asset} sent on {edge_id} did NOT project with edge_id="
                f"{edge_id!r}; observed: {sorted(observed)}"
            )

        # Negative: asset must NOT appear with any other edge_id. This is
        # the cross-edge isolation property — if it fails, either the
        # projector's env-default fallback fired (message-field missing),
        # or pipelines are bleeding across brokers (much worse).
        other_edges = observed - {edge_id}
        if other_edges:
            failures.append(
                f"{asset} sent on {edge_id} ALSO projected with foreign "
                f"edge_ids={sorted(other_edges)} — cross-edge leakage or "
                f"projector env-default fallback fired"
            )

    if failures:
        fail_(NAME, "isolation violations:\n  " + "\n  ".join(failures))

    pass_(NAME, f"per-edge isolation OK; "
                f"entity {TEST_PAIRS[0][1]} on {TEST_PAIRS[0][0]}, "
                f"entity {TEST_PAIRS[1][1]} on {TEST_PAIRS[1][0]} — "
                f"each entity carries its assigned edge_id and no other")


if __name__ == "__main__":
    main()
