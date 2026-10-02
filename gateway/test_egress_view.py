"""Verification tests for the egress pane's viewer-nation filter.

Gap being closed: every demo profile -- two edge operators and two
ATL+BDR regionals -- got back the identical records from the hub /egress/
pane, because nothing filtered the pane's one answer by who was asking. `egress_view.filter_decisions` is the fix; these
tests exercise the rule the leak measurement found missing.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import pytest

from egress_view import filter_decisions


def _record(asset_id, originator_nation, releasable_to=(), allowed=True):
    return {
        "asset_id": asset_id,
        "originator_nation": originator_nation,
        "releasable_to": list(releasable_to),
        "allowed": allowed,
        "reason": None if allowed else "no_nation_overlap",
        "decision_id": f"dec-{asset_id}",
    }


def _payload(records, **extra):
    payload = {
        "destination": "system:c2-stand-in-atl",
        "policy_version": "policy-test",
        "corpus_version": "corpus-test",
        "admitted": sum(1 for r in records if r["allowed"]),
        "refused": sum(1 for r in records if not r["allowed"]),
        "records": records,
    }
    payload.update(extra)
    return payload


ATL_ADMIT = _record("dis:1:1:1000", "ATL")
BDR_RELEASABLE_TO_ATL = _record("dis:2:1:1000", "BDR", releasable_to=["ATL"])
BDR_ONLY = _record("dis:2:1:1001", "BDR")
UNLABELLED = _record("dis:9:1:1000", None, releasable_to=[])


def test_atl_viewer_sees_atl_and_atl_releasable_bdr():
    """ATL-originated is shown; BDR-originated releasable_to [ATL] is shown;
    a BDR-only record is withheld."""
    payload = _payload([ATL_ADMIT, BDR_RELEASABLE_TO_ATL, BDR_ONLY])
    view = filter_decisions(payload, ["ATL"])
    ids = {r["asset_id"] for r in view["records"]}
    assert ids == {ATL_ADMIT["asset_id"], BDR_RELEASABLE_TO_ATL["asset_id"]}
    assert view["withheld"] == 1


def test_atl_and_bdr_viewer_sees_both_nations():
    payload = _payload([ATL_ADMIT, BDR_RELEASABLE_TO_ATL, BDR_ONLY])
    view = filter_decisions(payload, ["ATL", "BDR"])
    ids = {r["asset_id"] for r in view["records"]}
    assert ids == {ATL_ADMIT["asset_id"], BDR_RELEASABLE_TO_ATL["asset_id"],
                   BDR_ONLY["asset_id"]}
    assert view["withheld"] == 0


def test_unlabelled_record_is_withheld_from_every_viewer_including_all_nations():
    payload = _payload([UNLABELLED])
    for nations in (["ATL"], ["BDR"], ["ATL", "BDR"]):
        view = filter_decisions(payload, nations)
        assert view["records"] == []
        assert view["withheld"] == 1


def test_empty_nations_withholds_everything():
    payload = _payload([ATL_ADMIT, BDR_RELEASABLE_TO_ATL, BDR_ONLY])
    view = filter_decisions(payload, [])
    assert view["records"] == []
    assert view["withheld"] == 3
    assert view["viewer_nations"] == []


def test_counts_are_recomputed_over_visible_records_not_upstream():
    """Upstream admitted/refused are ignored even when they disagree with
    what is actually visible to this viewer."""
    refused_but_visible = _record("dis:1:1:2000", "ATL", allowed=False)
    payload = _payload([ATL_ADMIT, refused_but_visible, BDR_ONLY],
                       admitted=99, refused=99)
    view = filter_decisions(payload, ["ATL"])
    assert view["admitted"] == 1
    assert view["refused"] == 1
    assert view["withheld"] == 1


def test_unknown_top_level_key_does_not_appear_in_output():
    """The output is a whitelist, not a copy -- a future summary field must
    not ride along unfiltered."""
    payload = _payload([ATL_ADMIT], fleet_summary={"total": 999})
    view = filter_decisions(payload, ["ATL"])
    assert "fleet_summary" not in view


@pytest.mark.parametrize("bad_payload", [
    "not a dict",
    {"destination": "x", "records": "not a list"},
    {"destination": "x", "records": [{"ok": True}, "not a dict"]},
])
def test_malformed_input_raises_value_error(bad_payload):
    with pytest.raises(ValueError):
        filter_decisions(bad_payload, ["ATL"])
