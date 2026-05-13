"""
Test 13 — Mod compliance flow.

Pre-req: Test 12 has populated state. This test publishes a `ModApplied`
CmEvent for MWO-2024-117 (the SAFETY_OF_FLIGHT mod that's overdue on the
2024.2 baseline) and verifies:
  - asset-cm-state now shows MWO-2024-117 with state=MOD_STATE_APPLIED
  - The CRITICAL discrepancy for that mod is gone from the analyzer output
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _cm_helpers import (  # noqa: E402
    cm_service_alive,
    consume_asset_cm_state_for,
    submit_cm_event_via_cli,
)
from _helpers import fail_, pass_, send_fixture, skip_  # noqa: E402

NAME = "test_13_mod_compliance_flow"


def main() -> None:
    if not cm_service_alive():
        skip_(NAME, "cm-service is not reachable on :9080")

    # Ensure the asset exists (test order isn't guaranteed)
    try:
        send_fixture("sample_entity_state.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")
    time.sleep(4)

    rc = submit_cm_event_via_cli("dis:1:1:4773", mod_applied="MWO-2024-117")
    if rc != 0:
        fail_(NAME, f"cli/submit_cm_event.py exited rc={rc} — verify the "
                    f"cm-service container has /app/cli mounted and Kafka "
                    f"is reachable from inside the container")

    time.sleep(5)
    state = consume_asset_cm_state_for("dis:1:1:4773", timeout_s=20)
    if state is None:
        fail_(NAME, "no asset-cm-state record after mod_applied")

    matching = [m for m in (state.get("mod_status") or [])
                if m.get("mod_id") == "MWO-2024-117"]
    if not matching:
        fail_(NAME, "MWO-2024-117 not in mod_status post-update")

    # MOD_STATE_APPLIED == 4
    if matching[0].get("state") != 4:
        fail_(NAME, f"MWO-2024-117 state={matching[0].get('state')}; "
                    f"expected MOD_STATE_APPLIED (4)")

    # The DISCREPANCY_MISSING_MOD for this mod should be gone from
    # analyzer-derived discrepancies. Manual discrepancies persist separately.
    discrepancies = state.get("discrepancies") or []
    leftover = [d for d in discrepancies
                if d.get("related_mod_id") == "MWO-2024-117"]
    if leftover:
        fail_(NAME, f"MWO-2024-117 still in discrepancies after apply: "
                    f"{leftover[0].get('description')!r}")

    pass_(NAME,
          f"MWO-2024-117 -> APPLIED; "
          f"remaining_discrepancies={len(discrepancies)}; "
          f"overall_status={state.get('overall_status')}")


if __name__ == "__main__":
    main()
