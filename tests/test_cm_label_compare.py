"""Unit tests for the pure comparison in
hero_scenario_v3/test_61_cm_labels_equal_asset.py (no cluster needed)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "hero_scenario_v3"))

from test_61_cm_labels_equal_asset import compare  # noqa: E402


def lab(n, r):
    return {"n": n, "r": r}


def test_equal():
    assert compare(lab("ATL", ["BDR"]), lab("ATL", ["BDR"]), None)[0] == "ok"


def test_nation_differs():
    v, d = compare(lab("BDR", []), None, lab("ATL", []))
    assert v == "mismatch" and "BDR" in d and "ATL" in d


def test_releasable_order_only_passes():
    assert compare(lab("ATL", ["A", "B"]), None, lab("ATL", ["B", "A"]))[0] == "ok"


def test_releasable_content_differs():
    assert compare(lab("ATL", ["A"]), None, lab("ATL", ["A", "B"]))[0] == "mismatch"


def test_no_comparison_row():
    assert compare(lab("ATL", []), None, None)[0] == "no_comparison"


def test_declaration_wins_over_telemetry():
    assert compare(lab("ATL", []), lab("ATL", []), lab("BDR", []))[0] == "ok"
