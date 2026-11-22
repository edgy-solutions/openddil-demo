"""Tests for the ADR-0058 slice 3a pane additions: the disposition on
`GET /cases` and `GET /reports/states`.

Run: `python -m pytest egress/test_pane_reports.py -q` from openddil-demo/.

The store is a fake connection that answers by table. It records every SQL
string it is given, so a test can assert the pane issued SELECTs only.
"""
from __future__ import annotations

import datetime
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import pane_api  # noqa: E402
from kinds import Declarations  # noqa: E402

UTC = datetime.timezone.utc


def at(minute: int) -> datetime.datetime:
    return datetime.datetime(2026, 11, 1, 10, minute, 0, tzinfo=UTC)


ACTION = Declarations(key="/action_id", label="/label", case_ref="/case/id")
# An action kind that exists but declares no case_ref.
ACTION_NO_REF = Declarations(key="/action_id", label="/label")
COMPLETION = Declarations(key="/record_id", label="/label", completes_ref="/completes")


class FakeConn:
    """Answers by table; filters nothing by SQL, so the pane's own
    re-check of each pointer is what keeps a stray row out."""

    def __init__(self, ledger=(), intake=()):
        self.ledger = list(ledger)
        self.intake = list(intake)
        self.sql: list[str] = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "egress_delivered_events" in sql:
            if "ANY($1::text[])" in sql:
                return [r for r in self.ledger if r["episode_id"] in args[0]]
            asset = args[0]
            return [r for r in self.ledger if r.get("asset_id") == asset
                    and r["outcome"] == "delivered" and r["case_id"]]
        if "intake_records" in sql:
            return [r for r in self.intake if r["kind"] == args[0]]
        raise AssertionError(f"unexpected query: {sql}")

    async def close(self):
        pass


def ledger_row(episode="ep-1", case="case-1", outcome="delivered", first=0, **over):
    row = {
        "route": "route-x", "event_id": f"ev-{episode}", "outcome": outcome,
        "http_status": 200 if outcome == "delivered" else None, "case_id": case,
        "episode_id": episode, "asset_id": "asset-a", "component": "comp-1",
        "fault_code": "F-1", "first_recorded_at": at(first), "recorded_at": at(first + 1),
    }
    row.update(over)
    return row


def action_row(key, case, *, kind="ActionRecord", allowed=True, reason=None, minute=10,
               task="replace comp-1", role="releaser"):
    return {
        "kind": kind, "key": key,
        "body": json.dumps({"action_id": key, "case": {"id": case},
                            "work_order": {"task": task},
                            "approval_chain": [{"role": "chooser"}, {"role": role}]}),
        "decision": json.dumps({"allowed": allowed, "reason": reason}),
        "decided_at": at(minute),
    }


def completion_row(key, completes, *, outcome="done", episode="ep-1", minute=20,
                   allowed=True, reason=None):
    body = {"record_id": key, "completes": completes, "outcome": outcome}
    if episode is not None:
        body["episode_id"] = episode
    return {"kind": "Completion", "key": key, "body": json.dumps(body),
            "decision": json.dumps({"allowed": allowed, "reason": reason}),
            "decided_at": at(minute)}


def serve(monkeypatch, conn, declarations, action_kinds):
    async def fake_connect(dsn):
        return conn

    monkeypatch.setattr(pane_api.asyncpg, "connect", fake_connect)
    monkeypatch.setattr(pane_api, "store_dsn_from_env", lambda: "postgres://unused")
    monkeypatch.setattr(pane_api, "_kind_context", lambda: (declarations, set(action_kinds)))
    server = ThreadingHTTPServer(("127.0.0.1", 0), pane_api.PaneApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def get(server, path):
    url = f"http://127.0.0.1:{server.server_address[1]}{path}"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


@pytest.fixture
def server_for(monkeypatch):
    servers = []

    def make(conn, declarations, action_kinds):
        server = serve(monkeypatch, conn, declarations, action_kinds)
        servers.append(server)
        return server

    yield make
    for s in servers:
        s.shutdown()


OLD_CASE_KEYS = {"route", "case_id", "episode_id", "event_id", "asset_id",
                 "component", "fault_code", "delivered_at"}


def cases(server, asset="asset-a"):
    status, body = get(server, f"/cases?asset_id={asset}")
    assert status == 200
    return body["cases"]


# --- the disposition on /cases ----------------------------------------------

def test_admitted_action_draws_option_producer_and_time(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["disposition_state"] == "admitted"
    assert case["disposition"]["option"] == "replace comp-1"
    assert case["disposition"]["stage"] == "releaser"
    assert case["case_id"] == "case-1"  # the producer: the case, by id
    assert case["decided_at"] == at(10).isoformat()
    assert case["decision"] == {"allowed": True, "reason": None}


def test_refused_action_is_refused_with_its_reason_never_none(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-1", "case-1", allowed=False, reason="schema_invalid")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["disposition_state"] == "refused"
    assert case["decision"] == {"allowed": False, "reason": "schema_invalid"}


def test_case_with_no_action_names_the_absence(server_for):
    conn = FakeConn([ledger_row()], [])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["disposition_state"] == "none"
    assert case["disposition"] is None and case["decided_at"] is None


def test_latest_action_by_decided_at_wins(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-new", "case-1", minute=30, task="defer"),
        action_row("act-old", "case-1", minute=10, allowed=False, reason="schema_invalid"),
    ])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["disposition_state"] == "admitted"
    assert case["disposition"]["key"] == "act-new"


def test_check6_key_prefix_never_joins_and_a_kind_without_case_ref_is_unjoinable(server_for):
    # The key starts with the case id; the kind declares no case_ref.
    conn = FakeConn([ledger_row()], [action_row("case-1-act", "case-1")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION_NO_REF}, {"ActionRecord"}))
    assert case["disposition_state"] == "unjoinable"
    assert case["disposition"] is None
    # No intake row was even asked for: the kind has no pointer to join on.
    assert not any("intake_records" in s for s in conn.sql)


def test_check6_a_row_whose_pointer_names_another_case_is_not_joined(server_for):
    # Key prefix matches case-1, but the body names case-2.
    conn = FakeConn([ledger_row()], [action_row("case-1-act", "case-2")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["disposition_state"] == "none"


def test_existing_case_keys_are_present_and_unchanged(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert OLD_CASE_KEYS <= set(case)
    assert {k: case[k] for k in OLD_CASE_KEYS} == {
        "route": "route-x", "case_id": "case-1", "episode_id": "ep-1", "event_id": "ev-ep-1",
        "asset_id": "asset-a", "component": "comp-1", "fault_code": "F-1",
        "delivered_at": at(0).isoformat(),
    }
    assert set(case) - OLD_CASE_KEYS == {
        "disposition", "decided_at", "decision", "disposition_state"}


# --- GET /reports/states ----------------------------------------------------

def states(server, *ids):
    q = "&".join(f"episode_id={i}" for i in ids)
    status, body = get(server, f"/reports/states?{q}")
    assert status == 200
    return body["episodes"]


DECLS_WITH_COMPLETION = {"ActionRecord": ACTION, "Completion": COMPLETION}


def test_states_requires_an_episode_id(server_for):
    server = server_for(FakeConn(), {}, set())
    assert get(server, "/reports/states")[0] == 400


def test_states_ledger_and_released_rows(server_for):
    conn = FakeConn(
        [ledger_row("ep-1", "case-1"), ledger_row("ep-2", None, outcome="held", first=5)],
        [action_row("act-1", "case-1"),
         action_row("act-9", "case-9", allowed=False, reason="schema_invalid")])
    eps = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), "ep-1", "ep-2")
    [row] = eps["ep-1"]["ledger"]
    assert row["outcome"] == "delivered" and row["http_status"] == 200
    assert row["case_id"] == "case-1" and row["case_id_mismatch"] is False
    assert eps["ep-1"]["released"] == [{
        "kind": "ActionRecord", "key": "act-1", "case_id": "case-1",
        "decided_at": at(10).isoformat(), "allowed": True, "reason": None}]
    assert eps["ep-2"]["ledger"][0]["outcome"] == "held"
    assert eps["ep-2"]["released"] == []


def test_states_a_refused_release_carries_its_reason(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-1", "case-1", allowed=False, reason="schema_invalid")])
    eps = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), "ep-1")
    assert eps["ep-1"]["released"][0]["allowed"] is False
    assert eps["ep-1"]["released"][0]["reason"] == "schema_invalid"


def test_states_episode_with_no_ledger_row_is_empty(server_for):
    eps = states(server_for(FakeConn(), {"ActionRecord": ACTION}, {"ActionRecord"}), "ep-x")
    assert eps["ep-x"]["ledger"] == [] and eps["ep-x"]["released"] == []


def test_states_key_prefix_without_case_ref_is_not_released(server_for):
    conn = FakeConn([ledger_row()], [action_row("case-1-act", "case-1")])
    eps = states(server_for(conn, {"ActionRecord": ACTION_NO_REF}, {"ActionRecord"}), "ep-1")
    assert eps["ep-1"]["released"] == []


def test_completion_undeclared(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")])
    eps = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), "ep-1")
    assert eps["ep-1"]["completion"] == {"declared": False, "records": []}


def run_completion(server_for, comp_rows):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")] + comp_rows)
    return states(server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"}), "ep-1")["ep-1"]


def test_completion_matched_through_the_release_key(server_for):
    ep = run_completion(server_for, [completion_row("done-1", "act-1")])
    assert ep["completion"]["declared"] is True
    [rec] = ep["completion"]["records"]
    assert rec["completes"] == "act-1" and rec["outcome"] == "done"
    assert rec["decided_at"] == at(20).isoformat() and rec["allowed"] is True
    assert rec["episode_id_carried"] == "ep-1"
    assert ep["unmatched_completions"] == []


def test_completion_naming_a_release_this_tier_does_not_hold_is_unmatched(server_for):
    ep = run_completion(server_for, [completion_row("done-2", "act-elsewhere")])
    assert ep["completion"]["records"] == []
    [rec] = ep["unmatched_completions"]
    assert rec["key"] == "done-2" and rec["completes"] == "act-elsewhere"


def test_completion_is_never_matched_by_asset_or_time(server_for):
    # Names no release key at all; same episode and time window.
    ep = run_completion(server_for, [completion_row("done-3", None)])
    assert ep["completion"]["records"] == []


def test_completion_cancelled(server_for):
    ep = run_completion(server_for, [completion_row("c-1", "act-1", outcome="cancelled")])
    assert ep["completion"]["records"][0]["outcome"] == "cancelled"


def test_completion_refused_is_a_state_with_its_reason(server_for):
    ep = run_completion(server_for, [
        completion_row("c-1", "act-1", allowed=False, reason="schema_invalid")])
    rec = ep["completion"]["records"][0]
    assert rec["allowed"] is False and rec["reason"] == "schema_invalid"


def test_completion_carrying_another_episode_id_is_shown_and_stays_joined(server_for):
    ep = run_completion(server_for, [completion_row("c-1", "act-1", episode="ep-other")])
    [rec] = ep["completion"]["records"]
    assert rec["episode_id_carried"] == "ep-other"


def test_unknown_outcome_reads_null(server_for):
    ep = run_completion(server_for, [completion_row("c-1", "act-1", outcome="weird")])
    assert ep["completion"]["records"][0]["outcome"] is None


def test_pane_issues_selects_only(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1"),
                                     completion_row("c-1", "act-1")])
    server = server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"})
    states(server, "ep-1")
    cases(server)
    assert conn.sql and all(s.lstrip().upper().startswith("SELECT") for s in conn.sql)
