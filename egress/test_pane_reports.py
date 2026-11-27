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
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import pane_api  # noqa: E402
from kinds import Declarations  # noqa: E402

UTC = datetime.timezone.utc


def at(minute: int) -> datetime.datetime:
    return datetime.datetime(2026, 11, 1, 10, minute, 0, tzinfo=UTC)


# The ids a fault carries. KIND is invented: the real kind name is deployment
# config. cm-service names an episode by "episode|asset|component|fault_code";
# the egress assembler names the egress episode by
# "kind|tier|asset|component|fault_code" and each occurrence (the ledger's
# event_id) by the same seed plus the detected time in ns. All are uuid v5 and
# differ on real rows, so no fixture here may use one literal for two of them.
KIND = "FaultEvent"
TIER = "edge-01"   # the tier whose assembler wrote the ledger rows


def cm_id(asset, component, fault):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"episode|{asset}|{component}|{fault}"))


def egress_episode_id(asset, component, fault, tier):
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL, f"{KIND}|{tier}|{asset}|{component}|{fault}"))


def egress_event_id(asset, component, fault, tier, detected_at_ns):
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"{KIND}|{tier}|{asset}|{component}|{fault}|{detected_at_ns}"))


# Asset ids have the real shape dis:N:N:N.
ASSET_A, ASSET_B, ASSET_X = "dis:9:1:2001", "dis:9:1:2002", "dis:9:1:2099"


def ep_of(component="comp-1", fault="F-1", asset=ASSET_A):
    """The egress episode id of a fault."""
    return egress_episode_id(asset, component, fault, TIER)


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
        self.intake_args: list[tuple] = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "egress_delivered_events" in sql:
            if "ANY($1::text[])" in sql:
                assert '"asset_id" = ANY($1::text[])' in sql
                return [r for r in self.ledger if r["asset_id"] in args[0]]
            # The /cases read keeps delivered rows that carry a case id: the real
            # SQL says so, and the fake honours exactly what the SQL says.
            assert '"case_id" IS NOT NULL' in sql
            asset = args[0]
            return [r for r in self.ledger if r.get("asset_id") == asset
                    and r["outcome"] == "delivered" and r["case_id"] is not None]
        if "intake_records" in sql:
            self.intake_args.append(args)
            return [r for r in self.intake if r["kind"] == args[0]]
        raise AssertionError(f"unexpected query: {sql}")

    async def close(self):
        pass


def ledger_row(case="case-1", outcome="delivered", first=0, **over):
    """One egress_delivered_events row. case is an invented opaque string, or
    None, which is what a real delivered row carries (the receiver answered
    with no case id). The writer sets first_recorded_at and recorded_at to
    now() on first insert, so they are equal. The demo's stub sink answers 202.
    The episode and event ids are uuid v5, computed from the fault's triple and
    the first-recorded minute, so they differ from each other."""
    row = {
        "route": "to-case-desk", "outcome": outcome,
        "http_status": 202 if outcome == "delivered" else None, "case_id": case,
        "asset_id": ASSET_A, "component": "comp-1", "fault_code": "F-1",
        "first_recorded_at": at(first), "recorded_at": at(first),
    }
    row.update(over)
    triple = (row["asset_id"], row["component"], row["fault_code"])
    row.setdefault("episode_id", egress_episode_id(*triple, TIER))
    row.setdefault("event_id", egress_event_id(*triple, TIER, first * 60 * 10**9))
    return row


def action_row(key, case, *, kind="ActionRecord", allowed=True, reason=None, minute=10,
               task="replace comp-1", role="releaser", nation="ATL", releasable=()):
    return {
        "kind": kind, "key": key,
        "body": json.dumps({"action_id": key, "case": {"id": case},
                            "work_order": {"task": task},
                            "approval_chain": [{"role": "chooser"}, {"role": role}]}),
        "decision": json.dumps({"allowed": allowed, "reason": reason}),
        "decided_at": at(minute),
        "originator_nation": nation, "releasable_to": releasable,
    }


def completion_row(key, completes, *, outcome="done", episode=ep_of(), minute=20,
                   allowed=True, reason=None, nation="ATL", releasable=()):
    body = {"record_id": key, "completes": completes, "outcome": outcome}
    if episode is not None:
        body["episode_id"] = episode
    return {"kind": "Completion", "key": key, "body": json.dumps(body),
            "decision": json.dumps({"allowed": allowed, "reason": reason}),
            "decided_at": at(minute),
            "originator_nation": nation, "releasable_to": releasable}


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


def cases(server, asset=ASSET_A):
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
        "route": "to-case-desk", "case_id": "case-1", "episode_id": ep_of(),
        "event_id": egress_event_id(ASSET_A, "comp-1", "F-1", TIER, 0),
        "asset_id": ASSET_A, "component": "comp-1", "fault_code": "F-1",
        "delivered_at": at(0).isoformat(),
    }
    assert set(case) - OLD_CASE_KEYS == {
        "disposition", "decided_at", "decision", "disposition_state", "action_labels"}


def test_action_labels_are_the_joined_action_rows_labels(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-1", "case-1", nation="BDR", releasable=["ATL", "CHA"])])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["action_labels"] == {"originator_nation": "BDR",
                                     "releasable_to": ["ATL", "CHA"]}


def test_action_labels_null_array_reads_empty_and_null_originator_stays_null(server_for):
    row = action_row("act-1", "case-1")
    row["originator_nation"], row["releasable_to"] = None, None
    conn = FakeConn([ledger_row()], [row])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["action_labels"] == {"originator_nation": None, "releasable_to": []}


def test_action_labels_are_the_latest_actions(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-new", "case-1", minute=30, nation="BDR"),
        action_row("act-old", "case-1", minute=10, nation="ATL")])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["action_labels"]["originator_nation"] == "BDR"


def test_action_labels_null_when_no_action_joined(server_for):
    conn = FakeConn([ledger_row()], [])
    [case] = cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    assert case["action_labels"] is None


def test_the_action_select_names_the_label_columns(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")])
    cases(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}))
    sql = [q for q in conn.sql if "intake_records" in q]
    assert sql and all("originator_nation" in q and "releasable_to" in q for q in sql)


# --- GET /reports/states ----------------------------------------------------

def states(server, *assets):
    q = "&".join(f"asset_id={a}" for a in assets)
    status, body = get(server, f"/reports/states?{q}")
    assert status == 200
    return body


def fault(body, component="comp-1", fault_code="F-1", asset=ASSET_A):
    [block] = [b for b in body["faults"] if (b["asset_id"], b["component"], b["fault_code"])
               == (asset, component, fault_code)]
    return block


DECLS_WITH_COMPLETION = {"ActionRecord": ACTION, "Completion": COMPLETION}


def test_states_requires_an_asset_id(server_for):
    server = server_for(FakeConn(), {}, set())
    status, body = get(server, "/reports/states")
    assert (status, body) == (400, {"error": "asset_id required"})
    # episode_id is no longer read
    assert get(server, "/reports/states?episode_id=ep-1")[0] == 400


def test_states_caps_the_asset_ids(server_for):
    server = server_for(FakeConn(), {}, set())
    n = pane_api.STATES_ASSET_LIMIT
    ok = "&".join(f"asset_id=a{i}" for i in range(n))
    assert get(server, f"/reports/states?{ok}")[0] == 200
    status, body = get(server, f"/reports/states?{ok}&asset_id=extra")
    assert (status, body) == (400, {"error": f"at most {n} asset_id"})


def test_states_groups_by_the_fault_triple_sorted(server_for):
    conn = FakeConn([
        ledger_row("case-2", component="comp-2", first=5),
        ledger_row("case-1", first=0),
        ledger_row(None, outcome="held", first=8, asset_id=ASSET_B),
        ledger_row(None, first=9),
    ], [action_row("act-1", "case-1"),
        action_row("act-9", "case-9", allowed=False, reason="schema_invalid")])
    body = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}),
                  ASSET_A, ASSET_B)
    assert [(b["asset_id"], b["component"], b["fault_code"]) for b in body["faults"]] == [
        (ASSET_A, "comp-1", "F-1"), (ASSET_A, "comp-2", "F-1"),
        (ASSET_B, "comp-1", "F-1")]
    one = fault(body)
    # One fault, one egress episode id; the two occurrences have their own event ids.
    assert [r["episode_id"] for r in one["ledger"]] == [ep_of(), ep_of()]
    assert [r["event_id"] for r in one["ledger"]] == [
        egress_event_id(ASSET_A, "comp-1", "F-1", TIER, n * 60 * 10**9) for n in (0, 9)]
    assert one["ledger"][0]["outcome"] == "delivered" and one["ledger"][0]["http_status"] == 202
    assert one["ledger"][0]["case_id"] == "case-1"
    assert one["ledger"][0]["case_id_mismatch"] is False
    assert one["released"] == [{
        "kind": "ActionRecord", "key": "act-1", "case_id": "case-1",
        "decided_at": at(10).isoformat(), "allowed": True, "reason": None,
        "labels": {"originator_nation": "ATL", "releasable_to": []}}]
    assert fault(body, "comp-2")["released"] == []
    assert fault(body, asset=ASSET_B)["ledger"][0]["outcome"] == "held"
    assert body["unkeyed_ledger"] == 0


def test_states_unkeyed_ledger_counts_rows_missing_component_or_fault_code(server_for):
    conn = FakeConn([
        ledger_row(),
        ledger_row(component=None), ledger_row(fault_code=None),
        ledger_row(component=""), ledger_row(fault_code=""),
    ])
    body = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), ASSET_A)
    assert body["unkeyed_ledger"] == 4
    assert [b["component"] for b in body["faults"]] == ["comp-1"]
    assert ledger_row(component=None)["event_id"] not in json.dumps(body)


def test_states_asset_with_no_ledger_row_has_no_blocks(server_for):
    body = states(server_for(FakeConn(), {"ActionRecord": ACTION}, {"ActionRecord"}), ASSET_X)
    assert body == {"faults": [], "unkeyed_ledger": 0}


def test_states_a_refused_release_carries_its_reason(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-1", "case-1", allowed=False, reason="schema_invalid")])
    body = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), ASSET_A)
    assert fault(body)["released"][0]["allowed"] is False
    assert fault(body)["released"][0]["reason"] == "schema_invalid"


def test_states_key_prefix_without_case_ref_is_not_released(server_for):
    conn = FakeConn([ledger_row()], [action_row("case-1-act", "case-1")])
    body = states(server_for(conn, {"ActionRecord": ACTION_NO_REF}, {"ActionRecord"}),
                  ASSET_A)
    assert fault(body)["released"] == []


def test_states_released_and_completion_records_carry_the_intake_labels(server_for):
    conn = FakeConn([ledger_row()], [
        action_row("act-1", "case-1", nation="BDR", releasable=["CHA"]),
        completion_row("c-1", "act-1", nation="CHA", releasable=["ATL"]),
        completion_row("c-2", "act-elsewhere", nation="BDR", releasable=None)])
    body = states(server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"}), ASSET_A)
    block = fault(body)
    assert block["released"][0]["labels"] == {
        "originator_nation": "BDR", "releasable_to": ["CHA"]}
    assert block["completion"]["records"][0]["labels"] == {
        "originator_nation": "CHA", "releasable_to": ["ATL"]}
    # A null releasable_to reads [].
    assert block["unmatched_completions"][0]["labels"] == {
        "originator_nation": "BDR", "releasable_to": []}


def test_completion_undeclared(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1")])
    body = states(server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"}), ASSET_A)
    assert fault(body)["completion"] == {"declared": False, "records": []}


def run_completion(server_for, comp_rows, ledger_rows=None):
    conn = FakeConn(ledger_rows or [ledger_row()],
                    [action_row("act-1", "case-1")] + comp_rows)
    server = server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"})
    return fault(states(server, ASSET_A)), conn


def test_completion_matched_through_the_release_key(server_for):
    ep, _ = run_completion(server_for, [completion_row("done-1", "act-1")])
    assert ep["completion"]["declared"] is True
    [rec] = ep["completion"]["records"]
    assert rec["completes"] == "act-1" and rec["outcome"] == "done"
    assert rec["decided_at"] == at(20).isoformat() and rec["allowed"] is True
    assert rec["episode_id_carried"] == ep_of()
    assert ep["unmatched_completions"] == []


def test_completions_are_fetched_by_the_ledgers_egress_side_ids(server_for):
    conn = FakeConn([
        ledger_row("case-1", component="comp-z"),
        ledger_row(None, first=3, component="comp-b"),
        ledger_row(None, first=4, component="comp-b"), ledger_row(None, component=None)],
        [action_row("act-1", "case-1"), completion_row("done-1", "act-1")])
    states(server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"}), ASSET_A)
    completion_calls = [a for a in conn.intake_args if a[0] == "Completion"]
    assert completion_calls
    # (kind, completes path, release keys, episode path, episode ids)
    assert all(a[4] == sorted([ep_of("comp-b"), ep_of("comp-z")]) for a in completion_calls)


def test_completion_naming_a_release_this_tier_does_not_hold_is_unmatched(server_for):
    ep, _ = run_completion(server_for, [completion_row("done-2", "act-elsewhere")])
    assert ep["completion"]["records"] == []
    [rec] = ep["unmatched_completions"]
    assert rec["key"] == "done-2" and rec["completes"] == "act-elsewhere"


def test_an_unmatched_completion_is_listed_on_the_block_holding_its_episode_id(server_for):
    conn = FakeConn(
        [ledger_row("case-1"), ledger_row(None, component="comp-2")],
        [action_row("act-1", "case-1"),
         completion_row("done-2", "act-elsewhere", episode=ep_of("comp-2"))])
    body = states(server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"}), ASSET_A)
    assert fault(body)["unmatched_completions"] == []
    assert [r["key"] for r in fault(body, "comp-2")["unmatched_completions"]] == ["done-2"]


def test_completion_is_never_matched_by_asset_or_time(server_for):
    # Names no release key at all; same episode and time window.
    ep, _ = run_completion(server_for, [completion_row("done-3", None)])
    assert ep["completion"]["records"] == []


def test_completion_cancelled(server_for):
    ep, _ = run_completion(server_for, [completion_row("c-1", "act-1", outcome="cancelled")])
    assert ep["completion"]["records"][0]["outcome"] == "cancelled"


def test_completion_refused_is_a_state_with_its_reason(server_for):
    ep, _ = run_completion(server_for, [
        completion_row("c-1", "act-1", allowed=False, reason="schema_invalid")])
    rec = ep["completion"]["records"][0]
    assert rec["allowed"] is False and rec["reason"] == "schema_invalid"


def test_completion_carrying_another_episode_id_is_shown_and_stays_joined(server_for):
    ep, _ = run_completion(server_for, [completion_row("c-1", "act-1", episode=ep_of("comp-other", "F-9"))])
    [rec] = ep["completion"]["records"]
    assert rec["episode_id_carried"] == ep_of("comp-other", "F-9")


def test_unknown_outcome_reads_null(server_for):
    ep, _ = run_completion(server_for, [completion_row("c-1", "act-1", outcome="weird")])
    assert ep["completion"]["records"][0]["outcome"] is None


def test_pane_issues_selects_only(server_for):
    conn = FakeConn([ledger_row()], [action_row("act-1", "case-1"),
                                     completion_row("c-1", "act-1")])
    server = server_for(conn, DECLS_WITH_COMPLETION, {"ActionRecord"})
    states(server, ASSET_A)
    cases(server)
    assert conn.sql and all(s.lstrip().upper().startswith("SELECT") for s in conn.sql)


def test_intake_config_kinds_read_without_importing_intake(tmp_path, monkeypatch):
    """The pane reads the intake config's kind names itself, so it never
    imports intake and its producer (produces.yaml lists no topic for it)."""
    cfg = tmp_path / "intake.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "ActionRecord"},
                               {"name": "b", "kind": "CompletionRecord"},
                               {"name": "c"}, "not an entry"]), encoding="utf-8")
    monkeypatch.setattr(pane_api, "KINDS_DIR", tmp_path / "absent")
    monkeypatch.setenv("OPENDDIL_EGRESS_INTAKE_CONFIG", str(cfg))
    _, kinds = pane_api._kind_context()
    assert kinds == {"ActionRecord", "CompletionRecord"}
    assert "intake" not in pane_api.__dict__
    cfg.write_text("{}", encoding="utf-8")
    assert pane_api._kind_context()[1] == set()


# --- a delivered row with no case id (the real default) ------------------------

def test_a_delivered_row_with_no_case_id_is_in_the_ledger_and_absent_from_cases(
        server_for):
    # The receiver answered with no case id, so the row is delivered, case_id NULL.
    conn = FakeConn([ledger_row(None)], [])
    server = server_for(conn, {"ActionRecord": ACTION}, {"ActionRecord"})
    assert cases(server) == []
    cases_sql = [q for q in conn.sql if "egress_delivered_events" in q
                 and "ANY($1::text[])" not in q]
    assert cases_sql and all('"case_id" IS NOT NULL' in q for q in cases_sql)
    block = fault(states(server, ASSET_A))
    assert [(r["outcome"], r["case_id"], r["http_status"]) for r in block["ledger"]] == [
        ("delivered", None, 202)]


# --- the two id formulas never collapse into one -------------------------------

def test_fixture_ids_follow_both_formulas():
    asset, comp, fault_code = ASSET_A, "comp-1", "F-1"
    cm = cm_id(asset, comp, fault_code)
    ep = egress_episode_id(asset, comp, fault_code, TIER)
    ev = egress_event_id(asset, comp, fault_code, TIER, 0)
    assert cm != ep and ep != ev and cm != ev
    for one in (cm, ep, ev):
        assert uuid.UUID(one).version == 5
    for row in (ledger_row(), ledger_row(None, first=3), ledger_row(outcome="held", first=4)):
        assert row["event_id"] != row["episode_id"]
        assert uuid.UUID(row["event_id"]).version == 5
        assert uuid.UUID(row["episode_id"]).version == 5
        assert row["episode_id"] != cm
        assert row["first_recorded_at"] == row["recorded_at"]
