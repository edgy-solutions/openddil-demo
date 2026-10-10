"""
Test 32 — DDIL disconnect raises the staleness banner.

This test runs against the REAL DDIL mechanic (ADR-0021), not a UI
simulation: it disables the toxiproxy hq-link proxy — a genuine WAN sever —
and asserts the HQ view raises its "SYSTEM FREEZE / ALL LINKS DOWN"
overlay within 30s. In compose every link into HQ crosses the one hq-link
proxy, so this one cut takes down every link HQ monitors -- the only
condition under which HQ, which has no uplink, freezes. The path under
test is end-to-end:

    sever toxiproxy hq-link
      -> no child tier's heartbeat reaches redpanda-hq
      -> every link_status row HQ watches reads down
      -> ElectricSQL syncs the rows
      -> HqApp renders the freeze overlay

The hq-link is always restored afterwards (severed_hq_link context manager
+ run_ui_test backstop), so this test cannot leave the pipeline severed
for the tests that follow it.

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, restore_hq_link, run_ui_test, severed_hq_link  # noqa: E402

NAME = "test_32_ui_ddil_disconnect_banner"
FREEZE_TEXT = "SYSTEM FREEZE"
BANNER_TIMEOUT_MS = 30_000


def body(page) -> str:
    # Precondition reset: a prior run that crashed mid-sever could have left
    # the link down. Restore it and confirm the HQ view is in the un-severed
    # state before we start.
    restore_hq_link()
    open_view(page, "hq")
    page.get_by_text(FREEZE_TEXT, exact=False).wait_for(state="hidden")

    # Sever the real WAN link, then wait for the UI to react.
    with severed_hq_link():
        page.get_by_text(FREEZE_TEXT, exact=False).first.wait_for(
            state="visible", timeout=BANNER_TIMEOUT_MS
        )
        # The overlay's subtitle names the cause — assert it too so a
        # generic freeze can't pass for the all-links-down banner specifically.
        page.get_by_text("ALL LINKS DOWN", exact=False).first.wait_for(
            state="visible"
        )

    return "real toxiproxy hq-link sever raised the HQ SYSTEM FREEZE banner within 30s"


if __name__ == "__main__":
    run_ui_test(NAME, body)
