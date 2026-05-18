"""
Test 42 — WindowedTelemetry per-edge stamping (ADR-0023 §A.2).

6a left asset-telemetry-windows attributed via env-default only (the
projector telemetry_windows handler called origin_provenance() because
WindowedTelemetry didn't have a Provenance field). 6b §A adds the proto
field, faust-edge stamps it from env, the projector reads it from the
message.

This test closes the 6a coverage gap on the windowed path by sending
enough samples on edge-01 AND edge-02 to trigger faust-edge's
EMIT_EVERY_N_SAMPLES window emit, then verifying per-asset rows in
asset_telemetry_windows carry the correct edge_id (positive) and do
NOT appear with any other edge_id (negative).

Symmetric to test_41 for telemetry-latest, applied one tier up.
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

NAME = "test_42_windowed_emission_per_edge"

# EMIT_EVERY_N_SAMPLES default is 5; send 6 to comfortably trigger.
SAMPLES_PER_ENTITY = 6
SAMPLE_INTERVAL_S = 0.5

TEST_PAIRS = [
    ("edge-01", "region-east", 1820),
    ("edge-02", "region-east", 2820),
]


def _send_pdu(entity: int, edge_id: str, location_offset: float) -> None:
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"WIN-{entity}",
        # Move slightly each sample so derived sustainment / windowing has
        # variation to work with — pure-stationary entities don't always
        # exercise the trend calculation.
        location_ecef=(location_offset, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(2.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id=edge_id)
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed for entity {entity} on {edge_id}: {exc}")


def main() -> None:
    # Send SAMPLES_PER_ENTITY PDUs to each entity, alternating edges to
    # mix up the broker traffic. Each PDU at a slightly different ECEF
    # x-offset so trend/distance accumulators see real change.
    for i in range(SAMPLES_PER_ENTITY):
        for edge_id, _region, entity in TEST_PAIRS:
            _send_pdu(entity, edge_id, location_offset=float(i * 100))
        time.sleep(SAMPLE_INTERVAL_S)

    # Allow time for: DIS-mapper → faust-edge window buffer → emit on
    # 5th sample → projector reads asset-telemetry-windows.
    time.sleep(8)

    asset_ids = [f"dis:1:1:{e}" for _, _, e in TEST_PAIRS]
    sql = (
        "SELECT asset_id, edge_id, region_id FROM asset_telemetry_windows "
        f"WHERE asset_id IN ({','.join(repr(a) for a in asset_ids)}) "
        "ORDER BY asset_id"
    )
    rows = query_postgres(sql)
    seen: dict[str, set[str]] = {}
    region_seen: dict[str, str] = {}
    for r in rows:
        seen.setdefault(r[0], set()).add(r[1])
        region_seen[r[0]] = r[2]

    failures: list[str] = []
    for edge_id, region, entity in TEST_PAIRS:
        asset = f"dis:1:1:{entity}"
        observed = seen.get(asset, set())

        # Positive: row exists with correct edge_id.
        if edge_id not in observed:
            failures.append(
                f"{asset} sent on {edge_id} did NOT project to "
                f"asset_telemetry_windows with edge_id={edge_id!r}; "
                f"observed: {sorted(observed)}. Either faust-edge didn't "
                f"emit a window (insufficient samples?), or the projector "
                f"telemetry_windows handler isn't reading Provenance.edge_id "
                f"from the message — check for the rate-limited fallback "
                f"WARN in projector logs."
            )
            continue

        # Positive: region matches.
        actual_region = region_seen.get(asset)
        if actual_region != region:
            failures.append(
                f"{asset}: expected region_id={region!r}, got {actual_region!r}"
            )

        # Negative: no foreign edge_ids on this asset's window rows.
        other_edges = observed - {edge_id}
        if other_edges:
            failures.append(
                f"{asset} sent on {edge_id} ALSO projected with foreign "
                f"edge_ids={sorted(other_edges)} — cross-edge leakage or "
                f"projector env-default fallback fired"
            )

    if failures:
        fail_(NAME, "windowed-emission isolation violations:\n  "
                    + "\n  ".join(failures))

    pass_(NAME, f"WindowedTelemetry per-edge stamping OK; entity "
                f"{TEST_PAIRS[0][1]} on {TEST_PAIRS[0][0]} and entity "
                f"{TEST_PAIRS[1][1]} on {TEST_PAIRS[1][0]} each project "
                f"with their assigned edge_id (positive + negative)")


if __name__ == "__main__":
    main()
