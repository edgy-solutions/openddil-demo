"""
Test 14 — CRITICAL discrepancy fires a CloudEvent on tactical-events.

The M1A2 SEPv3 baseline has MWO-2024-117 (SAFETY_OF_FLIGHT) with due_date
2025-12-31 — overdue as of 2026-05-12. First observe() initializes the
asset into NOT_MISSION_CAPABLE; per Agent-C semantics the transition from
the implicit "never alerted" state to NOT_MISSION_CAPABLE produces a
`openddil.configuration.discrepancy.detected` CloudEvent.
"""
from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _cm_helpers import (  # noqa: E402
    cm_service_alive,
    consume_tactical_events,
)
from _helpers import (  # noqa: E402
    build_entity_state_pdu,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

NAME = "test_14_critical_alert"


def main() -> None:
    if not cm_service_alive():
        skip_(NAME, "cm-service is not reachable on :9080")

    # Use a distinct entity number so prior test runs don't suppress the
    # alert (transition cache: once an asset is already CRITICAL, no new
    # alert fires until it transitions out and back in).
    entity_id = (uuid.uuid4().int & 0xFFFF) | 0x8000  # 32768..65535
    pdu = build_entity_state_pdu(
        site=1, application=1, entity=entity_id,
        kind=1, domain=1, country=225, category=1,
        subcategory=3, specific=1, extra=0,
        marking=f"ALERT-{entity_id}",
    )
    send_udp_bytes(pdu)
    asset_id = f"dis:1:1:{entity_id}"
    time.sleep(6)

    events = consume_tactical_events(asset_id, timeout_s=25)
    if not events:
        fail_(NAME, f"no tactical-events CloudEvent for {asset_id}; "
                    f"verify Restate subscription on raw-sensor-stream and "
                    f"that cm-service has registered with Restate")

    detected = [e for e in events
                if e.get("type") == "openddil.configuration.discrepancy.detected"]
    if not detected:
        fail_(NAME, f"no `detected` event for {asset_id}; got types "
                    f"{[e.get('type') for e in events]}")

    data = detected[0].get("data") or {}
    if data.get("current_status") != "CONFIG_STATUS_NOT_MISSION_CAPABLE":
        fail_(NAME, f"unexpected current_status={data.get('current_status')!r}")

    critical_discs = [d for d in (data.get("discrepancies") or [])
                       if d.get("severity") == 4]  # SEVERITY_CRITICAL
    if not critical_discs:
        fail_(NAME, "no CRITICAL discrepancy in the CloudEvent's data block")

    pass_(NAME,
          f"alert fired for {asset_id}: "
          f"current_status={data['current_status']} "
          f"critical_discrepancies={len(critical_discs)}")


if __name__ == "__main__":
    main()
