"""GET /reports/mine and GET /reports/tier, through the real PEP handler
(ADR-0058 slice 3a, DESIGN-2026-11-10 section 3 and the 3a checks 2-5, 8).

Electric, Topaz and the hub's pane are fakes on loopback. The fake Electric
and the fake pane record any request that is not a GET, and the tests assert
there was none; the Electric fake also counts shape opens (offset=-1).

Run:  python -m pytest -q gateway   (from openddil-demo/)
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

UTC = datetime.timezone.utc
T0 = datetime.datetime(2026, 11, 1, 10, 0, 0, tzinfo=UTC)


def t(minutes: int) -> datetime.datetime:
    return T0 + datetime.timedelta(minutes=minutes)


def pg(dt: datetime.datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S+00")


def ns(dt: datetime.datetime) -> int:
    return int(dt.timestamp()) * 1_000_000_000


# subject -> (nations, role). "pdp-down" is not here: it makes Topaz answer 500.
PEOPLE = {
    "maintainer-a": (["ATL"], "edge-operator"),
    "maintainer-b": (["ATL"], "edge-operator"),
    "maintainer-c": (["ATL"], "edge-operator"),
    "supervisor-b": (["ATL"], "supervisor"),
}

TIER = "edge-t"

# ---- the world the fake Electric serves -----------------------------------
def source(who, minute):
    return {"source": "manual", "reported_by": who, "reported_at_ns": ns(t(minute))}


def cm_row(asset, edge, episodes, nation="ATL", releasable="{}", region=None):
    return {"asset_id": asset, "edge_id": edge, "region_id": region,
            "originator_nation": nation, "releasable_to": releasable,
            "manual_discrepancies": json.dumps(episodes)}


def open_ep(eid, minute, sources, component="comp-1", fault="F-1"):
    return {"discrepancy_id": eid, "detected_at_ns": ns(t(minute)), "component": component,
            "fault_code": fault, "sources": sources}


def closed_row(eid, start, end, sources, *, edge=TIER, nation="ATL", releasable="{}",
               cleared_by="supervisor-b", resolution="repaired", asset="asset-a",
               region=None):
    return {"episode_id": eid, "detected_at": pg(t(start)), "asset_id": asset,
            "component": "comp-1", "fault_code": "F-1", "cleared_at": pg(t(end)),
            "cleared_by": cleared_by, "resolution": resolution,
            "sources": json.dumps(sources), "originator_nation": nation,
            "releasable_to": releasable, "edge_id": edge, "region_id": region}


def region_world():
    """region-r holds edge-t and edge-u; region-s is a sibling holding edge-v.
    An edge's row carries its edge_id and region_id; a region's row carries
    no edge_id and its region_id."""
    a = [source("maintainer-a", 1)]
    return {
        "asset_cm_state": [
            cm_row("asset-r", None, [open_ep("E-AT-R", 60, a)], region="region-r"),
            cm_row("asset-t", TIER, [open_ep("E-AT-T", 61, a)], region="region-r"),
            cm_row("asset-u", "edge-u", [open_ep("E-AT-U", 62, a)], region="region-r"),
            cm_row("asset-s", None, [open_ep("E-AT-S", 63, a)], region="region-s"),
            cm_row("asset-v", "edge-v", [open_ep("E-AT-V", 64, a)], region="region-s"),
        ],
        "failure_episodes": [
            closed_row("E-AT-U", 0, 30, a, edge="edge-u", region="region-r", asset="asset-u"),
            closed_row("E-AT-U-BDR", 10, 20, a, edge="edge-u", region="region-r",
                       asset="asset-u", nation="BDR", releasable="{}"),
            closed_row("E-AT-S", 5, 25, a, edge=None, region="region-s", asset="asset-s"),
        ],
    }


def default_world():
    return {
        "asset_cm_state": [
            cm_row("asset-a", TIER, [
                open_ep("E-OPEN", 60, [source("maintainer-a", 61)]),
                open_ep("E-DUP", 120, [source("maintainer-a", 121)]),
            ]),
            cm_row("asset-z", "edge-other", [
                open_ep("E-OTHER-TIER", 70, [source("maintainer-a", 71)])]),
        ],
        "failure_episodes": [
            closed_row("E-CLOSED", 0, 30, [source("maintainer-a", 1), source("maintainer-b", 2)]),
            closed_row("E-DUP", 40, 100, [source("maintainer-a", 41)]),
            closed_row("E-BDR", 10, 20, [source("maintainer-a", 11)],
                       nation="BDR", releasable="{}"),
            closed_row("E-ELSEWHERE", 10, 20, [source("maintainer-a", 11)], edge="edge-other"),
        ],
    }


class State:
    def __init__(self):
        self.reset()

    def reset(self):
        self.world = default_world()
        self.ignore_where = False
        self.shape_opens = 0
        self.electric_requests = []
        self.non_get = []
        self.pane_calls = []
        self.pane_mode = "ok"
        self.pane_episodes = {}


state = State()


def _json(handler, status, body):
    out = json.dumps(body).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(out)))
    handler.end_headers()
    handler.wfile.write(out)


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        if subject == "pdp-down":
            self.send_response(500)
            self.end_headers()
            return
        nations, role = PEOPLE.get(subject, ([], "observer"))
        x = {"allow": bool(nations), "allowed_nations": nations,
             "subject_known": subject in PEOPLE, "policy_version": "p1",
             "corpus_version": "c1", "role": role}
        _json(self, 200, {"response": {"result": [{"bindings": {"x": x}}]}})


class _NoWrites:
    """GET is served; anything else is recorded and refused."""

    def _refuse(self):
        state.non_get.append((self.command, self.path))
        _json(self, 405, {"error": "read only"})

    do_POST = do_PUT = do_DELETE = do_PATCH = _refuse  # noqa: N815

    def log_message(self, *a):
        pass


class FakeElectric(_NoWrites, BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        state.electric_requests.append(params)
        table = params.get("table")
        rows = list(state.world.get(table, []))
        where = params.get("where", "")
        if where and where != "true" and not state.ignore_where:
            # Evaluate `(edge_id = 'E' OR region_id = 'R')` exactly.
            e = where.split("edge_id = '", 1)[1].split("'", 1)[0]
            r_ = where.split("region_id = '", 1)[1].split("'", 1)[0]
            rows = [r for r in rows if r.get("edge_id") == e or r.get("region_id") == r_]
        if params.get("offset") == "-1":
            state.shape_opens += 1
        msgs = [{"key": f"{table}/{i}", "value": r, "headers": {"operation": "insert"}}
                for i, r in enumerate(rows)]
        msgs.append({"headers": {"control": "up-to-date"}})
        out = json.dumps(msgs).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("electric-handle", f"h-{table}")
        self.send_header("electric-offset", "0_0")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakePane(_NoWrites, BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        state.pane_calls.append(self.path)
        if state.pane_mode == "500":
            _json(self, 500, {"error": "boom"})
            return
        ids = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["episode_id"]
        _json(self, 200, {"episodes": {
            i: state.pane_episodes.get(i, pane_block()) for i in ids}})


def pane_block(ledger=(), released=(), declared=False, records=(), unmatched=()):
    return {"ledger": list(ledger), "released": list(released),
            "completion": {"declared": declared, "records": list(records)},
            "unmatched_completions": list(unmatched)}


def ledger(outcome="delivered", case="case-1", first=5, status=200, mismatch=False):
    return {"route": "route-x", "event_id": "ev-1", "outcome": outcome,
            "http_status": status if outcome == "delivered" else None, "case_id": case,
            "recorded_at": t(first + 1).isoformat(), "first_recorded_at": t(first).isoformat(),
            "case_id_mismatch": mismatch}


def released(case="case-1", allowed=True, reason=None, minute=20):
    return {"kind": "ActionRecord", "key": "act-1", "case_id": case,
            "decided_at": t(minute).isoformat(), "allowed": allowed, "reason": reason}


def completion(outcome="done", episode="E-OPEN", minute=30, key="done-1"):
    return {"kind": "Completion", "key": key, "completes": "act-1",
            "decided_at": t(minute).isoformat(), "allowed": True, "reason": None,
            "outcome": outcome, "episode_id_carried": episode}


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def rig():
    topaz, electric, pane = _serve(FakeTopaz), _serve(FakeElectric), _serve(FakePane)
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    front = _serve(pep.Pep)
    yield (pep, f"http://127.0.0.1:{front.server_port}",
           f"http://127.0.0.1:{pane.server_port}")
    for s in (front, topaz, electric, pane):
        s.shutdown()


@pytest.fixture
def env(rig):
    pep, url, pane_url = rig
    state.reset()
    pep.EGRESS_PANE = pane_url
    pep.PEP_TIER = TIER
    pep._reports_cache.clear()
    pep.REPORTS_CACHE_S = 60.0
    return pep, url


def get(url, subject):
    req = urllib.request.Request(url)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def mine(env, subject="maintainer-a"):
    code, body = get(env[1] + "/reports/mine", subject)
    assert code == 200, body
    return body


def rep(body, eid, *, open_=None):
    found = [r for r in body["reports"] if r["episode_id"] == eid
             and (open_ is None or r["open"] is open_)]
    assert len(found) == 1, (eid, [r["episode_id"] for r in body["reports"]])
    return found[0]


def names(report):
    return [s["state"] for s in report["states"]]


def state_of(report, name):
    return next(s for s in report["states"] if s["state"] == name)


# ---- check 2: read only ----------------------------------------------------
def test_check2_both_routes_succeed_and_nothing_is_written(env):
    assert mine(env)["reports"]
    assert rep(mine(env), "E-OPEN")["owning_tier"] == TIER
    code, body = get(env[1] + "/reports/tier", "supervisor-b")
    assert code == 200 and body["reports"]
    assert state.non_get == []
    assert all(r["table"] in ("failure_episodes", "asset_cm_state")
               for r in state.electric_requests)
    assert state.pane_calls and all(p.startswith("/reports/states?") for p in state.pane_calls)


# ---- check 3: every state --------------------------------------------------
def test_check3_filed_open_and_closed(env):
    body = mine(env)
    o = rep(body, "E-OPEN")
    assert o["open"] is True and o["cleared_at"] is None
    f = state_of(o, "filed")
    assert f["at"] == t(61).isoformat() and "cleared_by" not in f["detail"]
    c = rep(body, "E-CLOSED")
    assert c["open"] is False
    d = state_of(c, "filed")["detail"]
    assert d["cleared_by"] == "supervisor-b" and d["resolution"] == "repaired"
    assert d["cleared_at"] == t(30).isoformat()
    assert c["cleared_by"] == "supervisor-b" and c["resolution"] == "repaired"


def test_check3_no_combined_status_field(env):
    for r in mine(env)["reports"]:
        assert not {"status", "overall", "overall_status", "badge"} & set(r)
        assert "pending" not in json.dumps(r).lower()


def test_check3_queued_when_no_ledger_row(env):
    o = rep(mine(env), "E-OPEN")
    assert "queued for send" in names(o) and "sent" not in names(o)
    assert state_of(o, "queued for send")["detail"]["ledger"] == "no row"


def test_check3_queued_when_held_with_retries_exhausted(env):
    state.pane_episodes["E-OPEN"] = pane_block(
        ledger=[ledger(outcome="held", case=None)])
    q = state_of(rep(mine(env), "E-OPEN"), "queued for send")
    assert q["detail"]["held"] == "retries exhausted"


def test_check3_sent_and_case_opened(env):
    state.pane_episodes["E-OPEN"] = pane_block(ledger=[ledger(mismatch=True)])
    o = rep(mine(env), "E-OPEN")
    assert "queued for send" not in names(o)
    s = state_of(o, "sent")["detail"]
    assert s["http_status"] == 200 and s["recorded_at"] == t(6).isoformat()
    co = state_of(o, "case opened")["detail"]
    assert co["case_id"] == "case-1" and co["case_id_mismatch"] is True


def test_check3_delivered_without_a_case_id_is_sent_awaiting_reply(env):
    state.pane_episodes["E-OPEN"] = pane_block(ledger=[ledger(case=None)])
    o = rep(mine(env), "E-OPEN")
    assert "sent, awaiting reply" in names(o) and "case opened" not in names(o)


def test_check3_proposed_and_approved_are_read_in_3b(env):
    o = rep(mine(env), "E-OPEN")
    for name in ("proposed", "approved"):
        s = state_of(o, name)
        assert s["source"] == "iagent" and s["at"] is None
        assert s["detail"] == {"read": "read in 3b"}


def test_check3_released_admitted_and_refused(env):
    state.pane_episodes["E-OPEN"] = pane_block(
        ledger=[ledger()], released=[released()])
    r = state_of(rep(mine(env), "E-OPEN"), "released")
    assert r["at"] == t(20).isoformat() and r["detail"]["allowed"] is True
    state.pane_episodes["E-OPEN"] = pane_block(
        ledger=[ledger()],
        released=[released(allowed=False, reason="schema_invalid")])
    pep, _ = env
    pep._reports_cache.clear()
    r = state_of(rep(mine(env), "E-OPEN"), "released")
    assert r["detail"]["allowed"] is False and r["detail"]["reason"] == "schema_invalid"


def test_check3_work_recorded_no_source_while_undeclared(env):
    w = state_of(rep(mine(env), "E-OPEN"), "work recorded")
    assert w["detail"] == {"read": "no source"} and w["at"] is None


def declared(env, *records, unmatched=()):
    state.pane_episodes["E-OPEN"] = pane_block(
        ledger=[ledger()], released=[released()], declared=True,
        records=records, unmatched=unmatched)
    return rep(mine(env), "E-OPEN")


def test_check3_work_recorded_matched_with_its_time(env):
    w = state_of(declared(env, completion()), "work recorded")
    assert w["at"] == t(30).isoformat() and "episode_mismatch" not in w["detail"]


def test_check3_work_recorded_cancelled_leaves_the_episode_as_it_was(env):
    o = declared(env, completion(outcome="cancelled"))
    assert "work recorded: cancelled" in names(o)
    assert o["open"] is True and o["cleared_at"] is None


def test_check3_work_recorded_deferred(env):
    assert "work recorded: deferred" in names(declared(env, completion(outcome="deferred")))


def test_check3_work_recorded_episode_mismatch(env):
    w = state_of(declared(env, completion(episode="E-OTHER")), "work recorded")
    assert w["detail"]["episode_mismatch"] is True


def test_check3_unmatched_completion_is_listed_under_the_report(env):
    stray = completion(key="stray-1")
    stray["completes"] = "act-elsewhere"
    o = declared(env, unmatched=[stray])
    assert [u["key"] for u in o["unmatched"]] == ["stray-1"]
    assert "work recorded" not in [s["state"] for s in o["states"] if s["source"] == "intake"]


def test_check3_door_unreachable_replaces_the_hub_states(env):
    state.pane_mode = "500"
    o = rep(mine(env), "E-OPEN")
    assert "door at the hub, unreachable" in names(o)
    assert not {"queued for send", "sent", "released", "work recorded"} & set(names(o))
    assert "filed" in names(o)


def test_check3_door_unreachable_on_connection_refused(env):
    pep, url = env
    pep.EGRESS_PANE = "http://127.0.0.1:9"
    assert "door at the hub, unreachable" in names(rep(mine(env), "E-OPEN"))


def test_check3_no_pane_configured(env):
    pep, _ = env
    pep.EGRESS_PANE = ""
    o = rep(mine(env), "E-OPEN")
    assert "door not configured at this tier" in names(o)
    assert "queued for send" not in names(o)


# ---- check 4: the filer ----------------------------------------------------
def test_check4_two_sources_list_for_both_filers(env):
    assert rep(mine(env, "maintainer-a"), "E-CLOSED")
    assert rep(mine(env, "maintainer-b"), "E-CLOSED")


def test_check4_a_filer_sees_only_their_own_subject_in_the_detail(env):
    d = state_of(rep(mine(env, "maintainer-b"), "E-CLOSED"), "filed")["detail"]
    assert d["reported_by"] == ["maintainer-b"] and d["sources"] == 2


def test_check4_viewer_in_no_sources_gets_an_empty_list_with_the_state(env):
    body = mine(env, "maintainer-c")
    assert body["reports"] == [] and body["state"] == "no reports filed by you"


def test_check4_shared_id_joins_ledger_rows_by_interval(env):
    # E-DUP closed [40, 100); open one detected at 120.
    state.pane_episodes["E-DUP"] = pane_block(ledger=[
        ledger(case="case-old", first=50), ledger(case="case-new", first=130)])
    body = mine(env)
    old = rep(body, "E-DUP", open_=False)
    new = rep(body, "E-DUP", open_=True)
    assert state_of(old, "case opened")["detail"]["case_id"] == "case-old"
    assert state_of(new, "case opened")["detail"]["case_id"] == "case-new"
    assert body["unmatched_ledger"] == []


def test_check4_a_row_that_fits_neither_is_listed_never_dropped(env):
    # 110 falls in the gap [100, 120).
    state.pane_episodes["E-DUP"] = pane_block(ledger=[ledger(case="case-gap", first=110)])
    body = mine(env)
    assert [u["case_id"] for u in body["unmatched_ledger"]] == ["case-gap"]
    assert all("case opened" not in names(r) for r in body["reports"] if r["episode_id"] == "E-DUP")


def test_check4_a_late_row_for_a_single_episode_still_joins_it(env):
    # E-CLOSED cleared at 30; a held row delivered at 90 is still its row.
    state.pane_episodes["E-CLOSED"] = pane_block(ledger=[ledger(first=90)])
    body = mine(env)
    assert "case opened" in names(rep(body, "E-CLOSED"))
    assert body["unmatched_ledger"] == []


# ---- check 5: a supervisor's reports at the tier ---------------------------
def test_check5_supervisor_sees_the_tier_through_the_label_rule(env):
    code, body = get(env[1] + "/reports/tier", "supervisor-b")
    assert code == 200
    ids = {r["episode_id"] for r in body["reports"]}
    assert {"E-OPEN", "E-CLOSED", "E-DUP"} <= ids
    # The planted episode carries a label the supervisor lacks.
    assert "E-BDR" not in ids
    # Another tier's episodes are never listed.
    assert "E-OTHER-TIER" not in ids and "E-ELSEWHERE" not in ids
    # A supervisor's list names every filer.
    d = state_of(rep(body, "E-CLOSED"), "filed")["detail"]
    assert d["reported_by"] == ["maintainer-a", "maintainer-b"]
    assert body["reports"] and all(r["owning_tier"] == TIER for r in body["reports"])


def test_check5_edge_operator_gets_403_with_the_named_state(env):
    code, body = get(env[1] + "/reports/tier", "maintainer-a")
    assert code == 403
    assert body == {"error": "forbidden",
                    "state": "reports at this tier are for a supervisor"}
    assert state.pane_calls == []


def test_check5_unknown_subject_is_refused_before_any_read(env):
    code, _ = get(env[1] + "/reports/tier", "nobody")
    assert code == 403 and state.electric_requests == []


def test_check5_the_tier_clause_is_in_the_shape_where(env):
    get(env[1] + "/reports/tier", "supervisor-b")
    assert state.electric_requests
    assert all(f"edge_id = '{TIER}'" in r["where"] for r in state.electric_requests)


def test_check5_at_the_hub_the_store_is_not_narrowed(env):
    pep, _ = env
    pep.PEP_TIER = pep.HUB_TIER
    code, body = get(env[1] + "/reports/tier", "supervisor-b")
    assert code == 200
    assert {r["where"] for r in state.electric_requests} == {"true"}
    assert "E-ELSEWHERE" in {r["episode_id"] for r in body["reports"]}
    assert rep(body, "E-ELSEWHERE")["owning_tier"] == "edge-other"


def test_no_session_is_401(env):
    assert get(env[1] + "/reports/mine", None)[0] == 401


def test_pdp_down_is_503(env):
    assert get(env[1] + "/reports/mine", "pdp-down")[0] == 503


# ---- check 8: shapes do not grow with viewers ------------------------------
def test_check8_twenty_viewers_open_no_more_shapes_than_one(env):
    mine(env)
    one = state.shape_opens
    assert one == 2   # failure_episodes + asset_cm_state
    results = []

    def viewer(i):
        who = ("maintainer-a", "maintainer-b", "maintainer-c")[i % 3]
        results.append(get(env[1] + "/reports/mine", who)[0])

    threads = [threading.Thread(target=viewer, args=(i,)) for i in range(20)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert results == [200] * 20
    assert state.shape_opens == one


def test_check8_cold_concurrent_viewers_share_one_refresh(env):
    results = []

    def viewer(i):
        results.append(get(env[1] + "/reports/mine", "maintainer-a")[0])

    threads = [threading.Thread(target=viewer, args=(i,)) for i in range(20)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert results == [200] * 20
    assert state.shape_opens == 2


def test_the_pane_is_called_once_per_request_with_all_ids(env):
    mine(env)
    assert len(state.pane_calls) == 1
    q = urllib.parse.parse_qs(urllib.parse.urlparse(state.pane_calls[0]).query)
    assert set(q["episode_id"]) == {"E-OPEN", "E-CLOSED", "E-DUP", "E-BDR", "E-OTHER-TIER",
                                    "E-ELSEWHERE"} - {"E-OTHER-TIER", "E-ELSEWHERE"}


# ---- check 5 (design 3.3): the tier and the tiers below it ------------------
SHAPE = pytest.mark.parametrize("ignore_where", [False, True],
                                ids=["shape-filters", "shape-returns-all"])


def tier_at(env, tier, ignore_where):
    pep, url = env
    pep.PEP_TIER = tier
    state.world = region_world()
    state.ignore_where = ignore_where
    code, body = get(url + "/reports/tier", "supervisor-b")
    assert code == 200, body
    return body


@SHAPE
def test_check5_case1_a_region_lists_its_own_and_its_edges_with_owning_tier(env, ignore_where):
    body = tier_at(env, "region-r", ignore_where)
    assert rep(body, "E-AT-U", open_=True)["owning_tier"] == "edge-u"
    assert rep(body, "E-AT-U", open_=False)["owning_tier"] == "edge-u"
    assert rep(body, "E-AT-R")["owning_tier"] == "region-r"
    assert rep(body, "E-AT-T")["owning_tier"] == "edge-t"


@SHAPE
def test_check5_case2_the_label_rule_applies_to_a_row_below(env, ignore_where):
    body = tier_at(env, "region-r", ignore_where)
    assert "E-AT-U-BDR" not in {r["episode_id"] for r in body["reports"]}


@SHAPE
def test_check5_case3_a_region_does_not_see_a_sibling_region(env, ignore_where):
    body = tier_at(env, "region-r", ignore_where)
    ids = {r["episode_id"] for r in body["reports"]}
    assert "E-AT-S" not in ids and "E-AT-V" not in ids


@SHAPE
def test_check5_case4_an_edge_does_not_see_its_region_or_a_sibling_edge(env, ignore_where):
    body = tier_at(env, TIER, ignore_where)
    ids = {r["episode_id"] for r in body["reports"]}
    assert "E-AT-R" not in ids and "E-AT-U" not in ids
    assert rep(body, "E-AT-T")["owning_tier"] == TIER


def test_owning_tier_unit(env):
    pep, _ = env
    assert pep._owning_tier("edge-u", "region-r") == "edge-u"
    assert pep._owning_tier(None, "region-r") == "region-r"
    assert pep._owning_tier("", "region-r") == "region-r"
    assert pep._owning_tier(None, None) == "hub"
    assert pep._owning_tier("", "") == "hub"


def test_reports_in_scope_unit(env):
    pep, _ = env
    pep.PEP_TIER = "region-r"
    assert pep._reports_in_scope("edge-u", "region-r")
    assert pep._reports_in_scope(None, "region-r") and pep._reports_in_scope("", "region-r")
    assert not pep._reports_in_scope("edge-v", "region-s")
    assert not pep._reports_in_scope(None, None)
    pep.PEP_TIER = TIER
    assert pep._reports_in_scope(TIER, "region-r")
    assert not pep._reports_in_scope("edge-u", "region-r")
    assert not pep._reports_in_scope(None, "region-r")
    pep.PEP_TIER = pep.HUB_TIER
    assert pep._reports_in_scope("edge-v", "region-s") and pep._reports_in_scope(None, None)
