"""The label rule on /reports/mine ("report withheld") and the key whitelist
on /egress/cases, run through the real PEP handler with the route-audit rig.
"""
from __future__ import annotations

import json

import pytest

import test_pep_route_audit as audit
from test_pep_route_audit import (  # noqa: F401  (rig is a fixture)
    CANARY_ATL, CANARY_BDR, EDGE, LABELS, S, VIEWERS, call, pep_mod, rig)

NS_PER_S = 1_000_000_000
T0 = 1767261600  # 2026-01-01 10:00:00 UTC


def _episode(tag, kind, own_at, other_at=None, subject="viewer-atl"):
    sources = [{"source": "report", "reported_by": subject,
                "reported_at_ns": own_at * NS_PER_S}]
    if other_at is not None:
        sources.append({"source": "report", "reported_by": "someone-else",
                        "reported_at_ns": other_at * NS_PER_S})
    row = dict(LABELS[kind])
    row.update(
        episode_id=f"ep-{tag}", detected_at="2026-01-01 09:00:00+00",
        asset_id=f"ast-{tag}", component=f"comp-{tag}", fault_code=f"FC-{tag}",
        cleared_at=None, cleared_by=None, resolution=None,
        edge_id=EDGE, region_id=None, sources=json.dumps(sources))
    S.rows.setdefault("failure_episodes", []).append(row)


def _cases_for(case):
    S.rows.setdefault("asset_cm_state", []).append(dict(
        LABELS["ATL"], asset_id="ast-atl", edge_id=EDGE, region_id=None,
        manual_discrepancies=None))
    S.pane_cases["ast-atl"] = [case]
    status, raw = call("atl", "GET", "/egress/cases?asset_id=ast-atl")
    assert status == 200, raw
    return json.loads(raw)["cases"]


def _base_case(**extra):
    return dict({"route": "cortex", "case_id": "c1", "episode_id": "e1",
                 "event_id": "ev1", "asset_id": "ast-atl", "component": "comp",
                 "fault_code": "FC", "delivered_at": "2026-01-01T00:00:00Z",
                 "disposition": {"option": "o", "stage": "s", "kind": "k", "key": "x"},
                 "decided_at": "2026-01-01T01:00:00Z",
                 "decision": {"allowed": True, "reason": "r"},
                 "disposition_state": "decided",
                 "action_labels": dict(audit.LIST_LABELS["ATL"])}, **extra)


# --- /egress/cases ----------------------------------------------------------

def test_case_carries_only_whitelisted_keys(rig):
    case = _base_case(internal_note=CANARY_BDR)
    case["disposition"]["note"] = CANARY_BDR
    case["decision"]["trace"] = CANARY_BDR
    got = _cases_for(case)
    assert len(got) == 1
    assert set(got[0]) <= set(rig.CASE_KEYS)
    assert "action_labels" not in got[0]
    assert got[0]["disposition"] == {"option": "o", "stage": "s", "kind": "k", "key": "x"}
    assert got[0]["decision"] == {"allowed": True, "reason": "r"}
    assert CANARY_BDR not in json.dumps(got)


def test_case_from_an_older_pane_has_no_disposition_keys(rig):
    case = _base_case()
    for k in ("disposition", "decided_at", "decision", "disposition_state"):
        del case[k]
    got = _cases_for(case)[0]
    for k in ("disposition", "decided_at", "decision", "disposition_state"):
        assert k not in got
    assert got["case_id"] == "c1"


def test_hidden_action_reads_withheld(rig):
    got = _cases_for(_base_case(action_labels=dict(audit.LIST_LABELS["BDR"])))[0]
    assert got["disposition_state"] == "withheld"
    assert got["disposition"] is None
    assert got["decision"] == {"allowed": None, "reason": None}


# --- /reports/mine ----------------------------------------------------------

def _mine(viewer="atl"):
    status, raw = call(viewer, "GET", "/reports/mine")
    assert status == 200, raw
    return raw, json.loads(raw)


def test_mine_visible_and_hidden(rig, monkeypatch):
    decisions = []
    monkeypatch.setattr(rig, "record_decision", lambda **kw: decisions.append(kw))
    _episode("atl", "ATL", T0 + 100)
    _episode("bdr", "BDR", T0 + 200, other_at=T0 - 5000)
    raw, body = _mine()
    full, withheld = body["reports"][0], body["reports"][1]
    assert len(body["reports"]) == 2
    assert full["episode_id"] == "ep-atl" and full["asset_id"] == "ast-atl"
    assert full["fault_code"] == "FC-atl"
    assert withheld["episode_id"] == "withheld-1"
    assert [s["state"] for s in withheld["states"]] == ["report withheld"]
    assert withheld["states"][0]["at"] == "2026-01-01T10:03:20+00:00"
    for needle in (b"ep-bdr", b"ast-bdr", b"comp-bdr", b"FC-bdr"):
        assert needle not in raw
    assert [q["asset_id"][0] for q in S.called("pane-states")] == ["ast-atl"]
    assert decisions[-1]["withheld"] == 1
    assert decisions[-1]["shown"] == 1   # a withheld entry is counted once, as withheld


def test_mine_only_hidden_is_not_empty(rig):
    _episode("bdr", "BDR", T0)
    _episode("unl", "UNL", T0 + 10)
    raw, body = _mine()
    assert len(body["reports"]) == 2
    assert "state" not in body
    assert not S.called("pane-states")


def test_mine_withheld_order_and_numbering(rig):
    _episode("bdr", "BDR", T0 + 10)
    _episode("unl", "UNL", T0 + 500)
    raw, body = _mine()
    ids = [r["episode_id"] for r in body["reports"]]
    assert ids == ["withheld-1", "withheld-2"]
    ats = [r["states"][0]["at"] for r in body["reports"]]
    assert ats == sorted(ats, reverse=True)
    assert ats[0] == "2026-01-01T10:08:20+00:00"


def test_mine_empty_state_only_without_entries(rig):
    raw, body = _mine()
    assert body["reports"] == [] and body["state"] == "no reports filed by you"


def test_tier_still_drops_hidden_episodes(rig, monkeypatch):
    # A supervisor sees no entry at all for an episode it may not see.
    monkeypatch.setattr(rig, "ask_topaz", lambda subject: {
        "allow": True, "subject_known": True, "role": "supervisor",
        "allowed_nations": ["ATL"], "policy_version": "p", "corpus_version": "c"})
    _episode("atl", "ATL", T0)
    _episode("bdr", "BDR", T0 + 10)
    status, raw = call("atl", "GET", "/reports/tier")
    assert status == 200, raw
    body = json.loads(raw)
    assert [r["episode_id"] for r in body["reports"]] == ["ep-atl"]
    assert b"withheld" not in raw
