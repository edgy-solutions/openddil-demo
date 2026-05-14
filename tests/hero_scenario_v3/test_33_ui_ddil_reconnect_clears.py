"""
Test 33 — DDIL reconnect clears the staleness banner.

The companion to test 32, against the same real DDIL mechanic (ADR-0021).
It severs the toxiproxy hq-link, confirms the HQ view raises the
"SYSTEM FREEZE" overlay, then RESTORES the link and asserts the overlay
clears within 30s — proving the buffer drains and live updates resume,
not just that the sever is detectable.

    restore toxiproxy hq-link
      -> edge-hq-bridge reaches redpanda-hq again, drains bridge-group lag
      -> projector edge-buffer monitor flips hq_link_severed back to false
      -> ElectricSQL syncs the row
      -> HqApp removes the freeze overlay

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, restore_hq_link, run_ui_test, severed_hq_link  # noqa: E402

NAME = "test_33_ui_ddil_reconnect_clears"
FREEZE_TEXT = "SYSTEM FREEZE"
BANNER_TIMEOUT_MS = 30_000


def body(page) -> str:
    restore_hq_link()
    open_view(page, "hq")
    page.get_by_text(FREEZE_TEXT, exact=False).wait_for(state="hidden")

    # Sever, confirm the freeze raised (so the clear we test next is real),
    # then the context manager restores the link on exit.
    with severed_hq_link():
        page.get_by_text(FREEZE_TEXT, exact=False).first.wait_for(
            state="visible", timeout=BANNER_TIMEOUT_MS
        )

    # Link restored — the overlay must clear. `state="hidden"` is satisfied
    # whether the element is removed from the DOM or just not visible.
    page.get_by_text(FREEZE_TEXT, exact=False).wait_for(
        state="hidden", timeout=BANNER_TIMEOUT_MS
    )

    # And the view is interactive again — the HQ rollup panels are still
    # mounted and the freeze overlay is no longer intercepting.
    page.get_by_text("Fleet-Wide Readiness", exact=False).first.wait_for(
        state="visible"
    )

    return "real toxiproxy hq-link restore cleared the HQ SYSTEM FREEZE banner within 30s"


if __name__ == "__main__":
    run_ui_test(NAME, body)
