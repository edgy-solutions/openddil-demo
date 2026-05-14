"""
Test 31 — HQ view renders enterprise aggregate metrics.

Opens ?role=hq and asserts the HQ dashboard renders the enterprise rollup
panels — Fleet-Wide Readiness, Configuration Posture, Fleet Wear Trends —
and that the readiness panel resolved to a real numeric count rather than
the all-empty placeholder. Fleet-Wide Readiness sums CM status and
logistics severity across the whole fleet; a real digit there proves the
useAllCmState / useAllLogisticsStatus shapes delivered rows.

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, run_ui_test  # noqa: E402

NAME = "test_31_ui_hq_aggregate_metrics"


def body(page) -> str:
    open_view(page, "hq")

    for panel in ("Fleet-Wide Readiness", "Configuration Posture", "Fleet Wear Trends"):
        page.get_by_text(panel, exact=False).first.wait_for(state="visible")

    # Fleet-Wide Readiness renders count rows (status -> N). An empty fleet
    # shows only the "—" placeholder under both columns. Find the panel and
    # require at least one real digit in it.
    readiness = page.locator(
        "div.panel", has=page.get_by_text("Fleet-Wide Readiness", exact=False)
    ).first
    readiness.wait_for(state="visible")
    text = readiness.inner_text()
    assert re.search(r"\b\d+\b", text), (
        "Fleet-Wide Readiness shows no numeric counts — the fleet-wide CM / "
        f"logistics shapes did not sync. Panel text: {text!r}"
    )

    assert not page.console_errors, (
        f"HQ view rendered with JS errors: {page.console_errors}"
    )
    return "HQ view loaded; 3 enterprise rollup panels rendered, readiness shows real counts"


if __name__ == "__main__":
    run_ui_test(NAME, body)
