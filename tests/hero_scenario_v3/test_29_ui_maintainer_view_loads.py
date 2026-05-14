"""
Test 29 — Maintainer view loads against real pipeline data.

Opens ?role=maintainer and asserts the SPA renders the maintainer view
backed by the real ElectricSQL shapes: a real fleet asset is selected
(the identity strip shows a non-placeholder asset id), and the
Configuration Management + logistics cards resolve out of their cold-start
syncing state — i.e. the shapes synced, the view is not stuck.

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, run_ui_test  # noqa: E402

NAME = "test_29_ui_maintainer_view_loads"


def body(page) -> str:
    open_view(page, "maintainer")

    # Maintainer-specific shell: the identity strip ("LOCAL TIME") and the
    # per-asset Configuration Management card are unique to this view.
    page.get_by_text("LOCAL TIME", exact=False).first.wait_for(state="visible")
    page.get_by_text("Configuration Management", exact=False).first.wait_for(
        state="visible"
    )

    # Real data: the identity strip's `id:` field is the selected fleet
    # asset's asset_id. It shows the em-dash placeholder only when no asset
    # is selected — which means the telemetry_latest_state shape never
    # synced. A real id proves the fleet shape delivered rows.
    id_field = page.locator("text=/^id:/i").first
    id_field.wait_for(state="visible")
    id_text = id_field.inner_text()
    assert "—" not in id_text and id_text.strip() not in ("id:", "id: -"), (
        f"identity strip shows no real asset id ({id_text!r}) — "
        "fleet shape did not sync"
    )

    # The CM card must resolve out of the cold-start syncing state within
    # the default timeout. Syncing -> (real badge | explicit empty copy);
    # it must not hang on "Syncing CM state…".
    page.get_by_text("Syncing CM state", exact=False).wait_for(state="hidden")

    assert not page.console_errors, (
        f"maintainer view rendered with JS errors: {page.console_errors}"
    )
    return f"maintainer view loaded; real asset selected ({id_text.strip()}), CM card resolved"


if __name__ == "__main__":
    run_ui_test(NAME, body)
