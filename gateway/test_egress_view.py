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
    a BDR-only record is hidden -- but it is LABELLED (originator BDR), so it
    is not counted in `withheld`: that would leak BDR's record volume to an
    ATL-only viewer, exactly the AccessDenied rule this fix exists for."""
    payload = _payload([ATL_ADMIT, BDR_RELEASABLE_TO_ATL, BDR_ONLY])
    view = filter_decisions(payload, ["ATL"])
    ids = {r["asset_id"] for r in view["records"]}
    assert ids == {ATL_ADMIT["asset_id"], BDR_RELEASABLE_TO_ATL["asset_id"]}
    assert view["withheld"] == 0


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


def test_empty_nations_hides_everything_but_withholds_nothing_unlabelled():
    """A viewer with no entitlements sees no records -- but all three are
    LABELLED, so none is counted in `withheld`. `withheld` is not "how many
    are hidden from me"; it is "how many are unlabelled", which for this
    payload is zero regardless of who is asking."""
    payload = _payload([ATL_ADMIT, BDR_RELEASABLE_TO_ATL, BDR_ONLY])
    view = filter_decisions(payload, [])
    assert view["records"] == []
    assert view["withheld"] == 0
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
    assert view["withheld"] == 0


def test_withheld_does_not_leak_other_nations_record_volume():
    """THE LEAK CASE. An ATL viewer over 6 BDR-only records and 0 unlabelled
    records must see withheld == 0 -- `total - shown` would have reported 6,
    telling the ATL viewer exactly how many BDR records exist. Adding one
    unlabelled record raises withheld to 1 -- unlabelled, so withheld from
    every viewer, not a count of BDR's volume."""
    bdr_only = [_record(f"dis:2:1:200{i}", "BDR") for i in range(6)]
    payload = _payload(bdr_only)
    view = filter_decisions(payload, ["ATL"])
    assert view["records"] == []
    assert view["withheld"] == 0

    payload_with_unlabelled = _payload(bdr_only + [UNLABELLED])
    view = filter_decisions(payload_with_unlabelled, ["ATL"])
    assert view["records"] == []
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


# =============================================================================
# ADR-0046 s5 — the SAME filter over the maintenance pane's record shape
# =============================================================================
# `filter_decisions` reads only `originator_nation`/`releasable_to`/`allowed`
# off each record, and a maintenance action carries those three under those
# exact names (egress/pane_api.py's `build_decisions`) beside its work-order
# fields -- so this is the SAME function, over the SAME two clauses, proving
# no change in this file was needed for a second record source. F1-F4 below
# are all admitted by the gate (the mmis destination holds [ATL, BDR]) except
# F4, which never reaches a nation-overlap decision at all -- unlabelled.
def _action_record(action_id, originator_nation, releasable_to=()):
    return {
        "action_id": action_id,
        "event_id": f"{action_id}-event",
        "asset_id": f"{action_id}-asset",
        "owning_tier": "edge-01",
        "originator_nation": originator_nation,
        "releasable_to": list(releasable_to),
        "work_order": {"task": "remove and replace array module"},
        "approval_chain": [],
        "decided_at": "2026-10-02T00:00:00+00:00",
        "allowed": originator_nation is not None,
        "reason": None if originator_nation is not None else "unlabelled",
        "decision_id": f"dec-{action_id}",
    }


F1_ATL = _action_record("fixture-maint-1", "ATL")
F2_BDR = _action_record("fixture-maint-2", "BDR")
F3_ATL_RELEASABLE_BDR = _action_record("fixture-maint-3", "ATL", releasable_to=["BDR"])
F4_UNLABELLED = _action_record("fixture-maint-4", None)

MMIS_PAYLOAD = _payload([F1_ATL, F2_BDR, F3_ATL_RELEASABLE_BDR, F4_UNLABELLED])
MMIS_PAYLOAD["destination"] = "system:mmis-stand-in"


@pytest.mark.parametrize("nations,expected_ids,admitted,refused,withheld", [
    (["ATL"], {"fixture-maint-1", "fixture-maint-3"}, 2, 0, 1),
    (["BDR"], {"fixture-maint-2", "fixture-maint-3"}, 2, 0, 1),
    (["ATL", "BDR"], {"fixture-maint-1", "fixture-maint-2", "fixture-maint-3"}, 3, 0, 1),
])
def test_maintenance_action_payload_filters_like_any_other_record(
    nations, expected_ids, admitted, refused, withheld,
):
    view = filter_decisions(MMIS_PAYLOAD, nations)
    ids = {r["action_id"] for r in view["records"]}
    assert ids == expected_ids
    assert view["admitted"] == admitted
    assert view["refused"] == refused
    assert view["withheld"] == withheld
    # Work-order fields survive the filter unmodified -- the whitelist is at
    # the payload's top level only; a visible record is forwarded whole.
    for record in view["records"]:
        assert "work_order" in record
