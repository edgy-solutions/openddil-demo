"""
Test 34 — every DEMO_MOCK component self-identifies (ADR-0017).

ADR-0017 ("no orphan mocks") requires every component that renders against
synthetic / hardcoded data instead of real pipeline data to render a
DemoMockBanner. This test walks the three role views and asserts each
always-visible mock surface shows its amber "Demo Mock — <note>" badge.

Scope note — two DEMO_MOCK markers are intentionally NOT checked here:
  * TacticalRuleBuilder ("no rule-deployment pipeline") — lives in a modal
    that is closed by default; not an always-visible surface.
  * TacticalMapUnderlay — a pure react-three-fiber <mesh> primitive with no
    DOM wrapper, so it carries the DEMO_MOCK marker in source but renders
    no DOM banner by design (documented at its `void DEMO_MOCK` line).
Both are verified by source inspection / the ADR-0017 lint, not by this
browser test.

Playwright/browser optional — SKIPs if unavailable (see _ui_helpers).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ui_helpers import open_view, run_ui_test  # noqa: E402

NAME = "test_34_ui_demo_mock_banners"

# role -> the DemoMockBanner notes that must be visible on that view.
EXPECTED_BANNERS = {
    "maintainer": ["synthetic 3D schematic", "synthetic radar positions"],
    "regional":   ["synthetic theater positions"],
    "hq":         ["synthetic global positions"],
}


def body(page) -> str:
    checked = 0
    for role, notes in EXPECTED_BANNERS.items():
        open_view(page, role)
        for note in notes:
            # The DemoMockBanner renders "Demo Mock — <note>"; match the
            # whole badge so a stray occurrence of the note text elsewhere
            # can't satisfy the assertion.
            banner = page.locator(f"text=/Demo Mock.*{note}/i").first
            try:
                banner.wait_for(state="visible")
            except Exception as e:  # noqa: BLE001 - turn into a clear assert
                raise AssertionError(
                    f"{role} view: DEMO_MOCK banner '{note}' not visible — "
                    f"a mock surface is not self-identifying (ADR-0017). ({e})"
                ) from e
            checked += 1

    return f"all {checked} always-visible DEMO_MOCK surfaces render their banner across 3 views"


if __name__ == "__main__":
    run_ui_test(NAME, body)
