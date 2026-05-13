"""
Test 12 — CM service initializes state on first-seen asset.

Sends a DIS PDU for entity (1, 1, 4773) with platform_variant=M1A2-SEPv3 (via
ontology lookup). Verifies asset-cm-state contains a record for the canonical
asset_id with baseline-defaulted installed CIs and mod_status entries.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _cm_helpers import (  # noqa: E402
    cm_service_alive,
    consume_asset_cm_state_for,
)
from _helpers import fail_, pass_, send_fixture, skip_  # noqa: E402

NAME = "test_12_cm_first_seen_init"


def main() -> None:
    if not cm_service_alive():
        skip_(NAME, "cm-service is not reachable on :9080 — Phase 3 stack "
                    "not running (start `cm-service` + `cm-service-bootstrap`)")

    try:
        send_fixture("sample_entity_state.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")

    # Allow the full chain: sidecar -> Bronze -> Connect -> Silver ->
    # Restate subscription -> AssetCM.observe -> asset-cm-state
    time.sleep(5)

    state = consume_asset_cm_state_for("dis:1:1:4773", timeout_s=20)
    if state is None:
        fail_(NAME, "no asset-cm-state record for dis:1:1:4773 — check that "
                    "Restate subscription is wired (cm-service-bootstrap logs) "
                    "and that the ontology lookup resolved M1A2-SEPv3")

    if state.get("baseline_id") != "M1A2-SEPv3-Baseline-2024.2":
        fail_(NAME, f"unexpected baseline_id={state.get('baseline_id')!r}; "
                    f"expected M1A2-SEPv3-Baseline-2024.2")

    if state.get("lifecycle") not in (2,):  # LIFECYCLE_ACTIVE
        fail_(NAME, f"unexpected lifecycle={state.get('lifecycle')}; "
                    f"expected LIFECYCLE_ACTIVE (2)")

    installed = state.get("installed") or []
    if len(installed) < 1:
        fail_(NAME, "installed list is empty — baseline initialization "
                    "didn't populate slots")

    mod_status = state.get("mod_status") or []
    if not any(m.get("mod_id") == "MWO-2024-117" for m in mod_status):
        fail_(NAME, "MWO-2024-117 missing from mod_status — baseline mods "
                    "not initialized")

    pass_(NAME,
          f"baseline_id={state['baseline_id']} "
          f"installed={len(installed)} mods={len(mod_status)} "
          f"lifecycle={state['lifecycle']} "
          f"overall_status={state.get('overall_status')}")


if __name__ == "__main__":
    main()
