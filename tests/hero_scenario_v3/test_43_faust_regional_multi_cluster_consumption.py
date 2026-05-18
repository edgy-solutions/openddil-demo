"""
Test 43 — faust-regional multi-cluster consumption (ADR-0023 §B.1).

§B's structural novelty: a SINGLE faust-regional container per region
consumes from MULTIPLE Kafka clusters (its assigned edges' brokers) via
faust.Worker(aggregator, *source_apps). Test 43 verifies that the
multi-cluster fan-in actually delivers — events sent to a region's edge
brokers reach that region's per-region fan-in topic on hq, and events do
NOT cross-region-leak.

Pattern: produce a fresh entity to edge-01 (region-east). Verify the
region-east-fan-in topic on hq gains a new message keyed by that asset.
Verify the region-west-fan-in topic does NOT.

Symmetric to test_41's per-edge-isolation pattern, applied one tier up.
"""
from __future__ import annotations

import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    build_entity_state_pdu,
    fail_,
    pass_,
    send_udp_bytes,
)

NAME = "test_43_faust_regional_multi_cluster_consumption"


def _count_messages_with_key(topic: str, expected_key: str, *, timeout_s: int = 8) -> int:
    """Count messages whose key matches expected_key on a given topic
    (broker: redpanda-hq:19092). Uses rpk consume with -n 1000 limit;
    timeout-bounded so it returns even if topic has no matches.
    """
    cmd = [
        "docker", "exec", "openddil-demo-redpanda-hq-1",
        "timeout", str(timeout_s),
        "rpk", "topic", "consume", topic,
        "-X", "brokers=redpanda-hq:19092",
        "-o", "start",
        "-n", "1000",
        "-f", "%k\n",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 4)
    # rpk exits non-zero on timeout; that's fine — we just count keys we saw
    keys = [k.strip() for k in proc.stdout.splitlines() if k.strip()]
    return sum(1 for k in keys if k == expected_key)


def main() -> None:
    # Use a fresh entity in edge-01's range that we haven't seen before
    # this run. dis:1:1:1870 — not used by test_40/41/42.
    fresh_entity = 1870
    asset_id = f"dis:1:1:{fresh_entity}"

    pdu = build_entity_state_pdu(
        site=1, application=1, entity=fresh_entity,
        kind=1, domain=1, country=225, category=1, subcategory=3,
        specific=1, extra=0,
        marking=f"FAN-{fresh_entity}",
        location_ecef=(0.0, 0.0, 0.0),
        orientation_psi_theta_phi=(0.0, math.radians(0.0), 0.0),
    )
    try:
        send_udp_bytes(pdu, edge_id="edge-01")
    except Exception as exc:  # noqa: BLE001
        fail_(NAME, f"send_udp_bytes failed: {exc}")

    # Give the pipeline time:
    #   sensor-ingest -> dis-mapper -> raw-sensor-stream -> faust-edge ->
    #   asset-logistics-status (via cm/fusion stack) AND derived-sustainment
    #   (via faust-edge prognostics) on edge-01's broker
    #   -> faust-regional-east source App consumes -> wraps in envelope ->
    #   produces to region-east-fan-in on hq
    time.sleep(8)

    east_count = _count_messages_with_key("region-east-fan-in", asset_id)
    west_count = _count_messages_with_key("region-west-fan-in", asset_id)

    # POSITIVE: fresh asset reached region-east-fan-in (the multi-cluster
    # consumer machinery actually worked).
    if east_count == 0:
        fail_(NAME, f"asset {asset_id} sent to edge-01 (region-east) NOT "
                    f"observed on region-east-fan-in (count=0). Multi-cluster "
                    f"consumption broken — source-app-edge-01 isn't bridging.")

    # NEGATIVE: fresh asset did NOT cross-region-leak to region-west-fan-in.
    if west_count != 0:
        fail_(NAME, f"asset {asset_id} sent to edge-01 (region-east) LEAKED "
                    f"to region-west-fan-in (count={west_count}). Region "
                    f"isolation broken — source-app-edge-03 mis-tagged or "
                    f"fan-in topics cross-wired.")

    pass_(NAME, f"multi-cluster consumption OK: {asset_id} reached "
                f"region-east-fan-in (count={east_count}) and was correctly "
                f"absent from region-west-fan-in (count=0)")


if __name__ == "__main__":
    main()
