"""
Test 15 — No re-alert when the asset stays in CRITICAL state.

Send the same fixture twice for the same asset_id. The second observe()
must NOT produce a new tactical-events CloudEvent because `last_alerted_status`
is durably stored on the AssetCM Virtual Object — no in-memory cache to
expire, no spurious re-fires across cm-service restarts.

To prove the durability story, this test also restarts the cm-service
container between the two observations and verifies the transition cache
survives.
"""
from __future__ import annotations

import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _cm_helpers import (  # noqa: E402
    COMPOSE_DIR,
    cm_service_alive,
    consume_tactical_events,
    docker_compose,
)
from _helpers import (  # noqa: E402
    build_entity_state_pdu,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

NAME = "test_15_no_realert_on_stable_critical"


def main() -> None:
    if not cm_service_alive():
        skip_(NAME, "cm-service is not reachable on :9080")

    entity_id = (uuid.uuid4().int & 0xFFFF) | 0x8000
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=entity_id,
        kind=1, domain=1, country=225, category=1,
        subcategory=3, specific=1, extra=0,
        marking=f"STABLE-{entity_id}",
    )
    asset_id = f"dis:1:1:{entity_id}"

    # First observation → CRITICAL alert
    send_udp_bytes(pdu)
    time.sleep(6)
    first = consume_tactical_events(asset_id, timeout_s=25)
    detected_first = [e for e in first
                       if e.get("type") == "openddil.configuration.discrepancy.detected"]
    if not detected_first:
        fail_(NAME, "first observe() did not produce a `detected` alert; "
                    "test 14 should run first")

    # Restart cm-service to prove the transition cache is durable, not RAM
    proc = subprocess.run(
        docker_compose() + ["restart", "cm-service"],
        cwd=str(COMPOSE_DIR), capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        fail_(NAME, f"failed to restart cm-service: {proc.stderr}")

    # Wait for cm-service to come back and Restate to redeploy
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and not cm_service_alive():
        time.sleep(2)
    if not cm_service_alive():
        fail_(NAME, "cm-service did not return after restart")
    time.sleep(5)  # give bootstrap a chance to re-register subscriptions

    baseline_count = len(detected_first)
    send_udp_bytes(pdu)
    time.sleep(6)

    final = consume_tactical_events(asset_id, timeout_s=20)
    detected_final = [e for e in final
                       if e.get("type") == "openddil.configuration.discrepancy.detected"]
    if len(detected_final) > baseline_count:
        fail_(NAME, f"second observe() produced a spurious re-alert "
                    f"(baseline={baseline_count}, final={len(detected_final)}) "
                    f"— the durable last_alerted_status field isn't blocking "
                    f"re-fires as designed")

    pass_(NAME,
          f"stable-state idempotency preserved across cm-service restart "
          f"(detected events: {baseline_count} -> {len(detected_final)})")


if __name__ == "__main__":
    main()
