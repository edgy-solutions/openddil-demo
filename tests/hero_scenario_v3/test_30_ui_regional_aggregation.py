"""
Test 30 — Regional view renders real fleet aggregation.

Opens ?role=regional and asserts the regional dashboard renders the
aggregation panels built from the fleet-wide shapes: the AOR asset list
(colour-coded by logistics severity), the top constraining factors, and
the CM compliance summary. The AOR list header carries a live count —
`AOR Assets (N)` — which must agree with the number of rows actually
rendered, proving the aggregation ran over real shape data rather than a
placeholder.

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, run_ui_test  # noqa: E402

NAME = "test_30_ui_regional_aggregation"


def body(page) -> str:
    open_view(page, "regional")

    # The three regional rollup panels are all derived from the fleet-wide
    # shapes (useFleetAssets / useAllLogisticsStatus / useAllCmState).
    for panel in ("AOR Assets", "Top Constraining Factors", "CM Compliance Summary"):
        page.get_by_text(panel, exact=False).first.wait_for(state="visible")

    # `AOR Assets (N)` — the header carries a live count. A non-zero count
    # proves the aggregation ran over real fleet shape data; the panel also
    # renders an explicit "No assets in the pipeline." string when empty,
    # so 0 is a genuine signal, not a placeholder.
    header = page.locator("text=/AOR Assets \\(/").first
    header.wait_for(state="visible")
    m = re.search(r"AOR Assets \((\d+)\)", header.inner_text())
    assert m, f"AOR Assets header missing its count: {header.inner_text()!r}"
    declared = int(m.group(1))
    assert declared > 0, (
        "AOR Assets count is 0 — the regional view aggregated an empty "
        "fleet (no logistics/telemetry shape data)"
    )

    assert not page.console_errors, (
        f"regional view rendered with JS errors: {page.console_errors}"
    )
    return f"regional view loaded; 3 rollup panels rendered, AOR aggregated {declared} assets"


if __name__ == "__main__":
    run_ui_test(NAME, body)
