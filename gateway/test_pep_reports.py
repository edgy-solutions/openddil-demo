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
import uuid
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


# The ids a fault has. KIND is invented: the real kind name is deployment
# config. cm-service names an episode by "episode|<asset>|<component>|<fault>";
# the egress assembler names the egress episode by
# "<kind>|<tier>|<asset>|<component>|<fault>" and each occurrence (the ledger's
# event_id) by the same seed plus the detected time in ns. All are uuid v5 and
# the three differ on real rows, so no fixture may use one literal for two of them.
KIND = "FaultEvent"


def cm_id(asset, component, fault):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"episode|{asset}|{component}|{fault}"))


def egress_episode_id(asset, component, fault, tier):
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL, f"{KIND}|{tier}|{asset}|{component}|{fault}"))


def egress_event_id(asset, component, fault, tier, detected_at_ns):
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"{KIND}|{tier}|{asset}|{component}|{fault}|{detected_at_ns}"))


EGRESS_TIER = "edge-01"   # the tier whose assembler wrote the ledger rows


def egress_id(asset, component, fault, tier=EGRESS_TIER):
    return egress_episode_id(asset, component, fault, tier)


# Asset ids have the real shape dis:N:N:N.
ASSET_A, ASSET_B, ASSET_Z = "dis:9:1:2001", "dis:9:1:2002", "dis:9:1:2003"
ASSET_E = "dis:9:1:2004"
ASSET_R, ASSET_T, ASSET_U = "dis:9:1:2011", "dis:9:1:2012", "dis:9:1:2013"
ASSET_S, ASSET_V = "dis:9:1:2014", "dis:9:1:2015"

OPEN_T = (ASSET_A, "comp-1", "F-1")
CLOSED_T = (ASSET_A, "comp-closed", "F-3")
DUP_T = (ASSET_A, "comp-dup", "F-2")
BDR_T = (ASSET_A, "comp-bdr", "F-4")
OTHER_TIER_T = (ASSET_Z, "comp-1", "F-1")
ELSEWHERE_T = (ASSET_E, "comp-1", "F-1")
AT_R_T = (ASSET_R, "comp-1", "F-1")
AT_T_T = (ASSET_T, "comp-1", "F-1")
AT_U_T = (ASSET_U, "comp-1", "F-1")
AT_U_BDR_T = (ASSET_U, "comp-bdr", "F-4")
AT_S_T = (ASSET_S, "comp-1", "F-1")
AT_V_T = (ASSET_V, "comp-1", "F-1")

# The report ids: cm-service's discrepancy id, one per fault triple.
E_OPEN, E_CLOSED, E_DUP, E_BDR = (cm_id(*x) for x in (OPEN_T, CLOSED_T, DUP_T, BDR_T))
E_OTHER_TIER, E_ELSEWHERE = cm_id(*OTHER_TIER_T), cm_id(*ELSEWHERE_T)
E_AT_R, E_AT_T, E_AT_U = cm_id(*AT_R_T), cm_id(*AT_T_T), cm_id(*AT_U_T)
E_AT_U_BDR, E_AT_S, E_AT_V = cm_id(*AT_U_BDR_T), cm_id(*AT_S_T), cm_id(*AT_V_T)


# subject -> (nations, role). "pdp-down" is not here: it makes Topaz answer 500.
PEOPLE = {
    "maintainer-a": (["ATL"], "edge-operator"),
    "maintainer-b": (["ATL"], "edge-operator"),
    "maintainer-c": (["ATL"], "edge-operator"),
    "supervisor-b": (["ATL"], "supervisor"),
    "filer-bdr": (["BDR"], "edge-operator"),
    "filer-all": (["ATL", "BDR", "CHA"], "edge-operator"),
}

TIER = "edge-t"

# ---- the world the fake Electric serves -----------------------------------
def source(who, minute):
    """One element of `sources`: the five keys a real element has."""
    return {"description": "reported on the line", "event_id":
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"source|{who}|{minute}")),
            "reported_at_ns": ns(t(minute)), "reported_by": who, "source": "manual"}


# The real store has edge_id and region_id NOT NULL, and its writer uses
# non-empty tier names on every row. The default row is labelled by the
# originator only (releasable_to empty).
def cm_row(asset, edge, episodes, nation="ATL", releasable="{}", region="region-t"):
    return {"asset_id": asset, "edge_id": edge, "region_id": region,
            "originator_nation": nation, "releasable_to": releasable,
            "manual_discrepancies": json.dumps(episodes)}


def open_ep(eid, minute, sources, component="comp-1", fault="F-1"):
    """One element of manual_discrepancies: all twelve keys a real one has."""
    return {"advisory_provenance": {}, "component": component,
            "description": "found on the line", "detected_at_ns": ns(t(minute)),
            "discrepancy_id": eid, "fault_code": fault,
            "recommended_action": "inspect", "related_ci_id": "ci-1",
            "related_mod_id": "mod-1", "severity": 2, "sources": sources, "type": 1}


# A closed episode always carries a label and an edge_id (NOT NULL in the
# store); region_id is nullable. failure_episodes has no real rows, so its
# shape is from the columns only.
def closed_row(eid, start, end, sources, *, edge=TIER, nation="ATL", releasable="{}",
               cleared_by="supervisor-b", resolution="repaired", asset=ASSET_A,
               region=None, component="comp-1", fault="F-1"):
    return {"episode_id": eid, "detected_at": pg(t(start)), "asset_id": asset,
            "component": component, "fault_code": fault, "cleared_at": pg(t(end)),
            "cleared_by": cleared_by, "resolution": resolution,
            "sources": json.dumps(sources), "originator_nation": nation,
            "releasable_to": releasable, "edge_id": edge, "region_id": region}


def region_world():
    """region-r holds edge-t and edge-u; region-s is a sibling holding edge-v.
    An edge's row carries its edge_id and region_id.

    A region's own row (asset-r, asset-s, with an empty edge_id) is not
    producible by the real store, whose edge_id is NOT NULL; kept as a defence
    of the region-owning-tier branch in pep._owning_tier."""
    a = [source("maintainer-a", 1)]
    return {
        "asset_cm_state": [
            cm_row(ASSET_R, None, [open_ep(E_AT_R, 60, a)], region="region-r"),
            cm_row(ASSET_T, TIER, [open_ep(E_AT_T, 61, a)], region="region-r"),
            cm_row(ASSET_U, "edge-u", [open_ep(E_AT_U, 62, a)], region="region-r"),
            cm_row(ASSET_S, None, [open_ep(E_AT_S, 63, a)], region="region-s"),
            cm_row(ASSET_V, "edge-v", [open_ep(E_AT_V, 64, a)], region="region-s"),
        ],
        "failure_episodes": [
            closed_row(E_AT_U, 0, 30, a, edge="edge-u", region="region-r", asset=ASSET_U),
            closed_row(E_AT_U_BDR, 10, 20, a, edge="edge-u", region="region-r",
                       asset=ASSET_U, nation="BDR", releasable="{}",
                       component="comp-bdr", fault="F-4"),
            # edge-v holds the sibling region's closed episode (edge_id is NOT NULL).
            closed_row(E_AT_S, 5, 25, a, edge="edge-v", region="region-s", asset=ASSET_S),
        ],
    }


def default_world():
    return {
        "asset_cm_state": [
            cm_row(ASSET_A, TIER, [
                open_ep(E_OPEN, 60, [source("maintainer-a", 61)]),
                open_ep(E_DUP, 120, [source("maintainer-a", 121)],
                        component="comp-dup", fault="F-2"),
            ]),
            cm_row(ASSET_Z, "edge-other", [
                open_ep(E_OTHER_TIER, 70, [source("maintainer-a", 71)])],
                region="region-o"),
        ],
        "failure_episodes": [
            closed_row(E_CLOSED, 0, 30, [source("maintainer-a", 1), source("maintainer-b", 2)],
                       component="comp-closed", fault="F-3"),
            closed_row(E_DUP, 40, 100, [source("maintainer-a", 41)],
                       component="comp-dup", fault="F-2"),
            closed_row(E_BDR, 10, 20, [source("maintainer-a", 11)],
                       nation="BDR", releasable="{}", component="comp-bdr", fault="F-4"),
            closed_row(E_ELSEWHERE, 10, 20, [source("maintainer-a", 11)], edge="edge-other",
                       asset=ASSET_E),
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
        self.pane_queries = []
        self.pane_mode = "ok"
        self.pane_episodes = {}
        self.pane_unkeyed = 0


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
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        state.pane_queries.append(query)
        assets = set(query.get("asset_id", []))
        _json(self, 200, {"faults": [b for b in state.pane_episodes.values()
                                     if b["asset_id"] in assets],
                          "unkeyed_ledger": state.pane_unkeyed})


def pane_block(ledger=(), released=(), declared=False, records=(), unmatched=(),
               triple=OPEN_T):
    return {"asset_id": triple[0], "component": triple[1], "fault_code": triple[2],
            "ledger": list(ledger), "released": list(released),
            "completion": {"declared": declared, "records": list(records)},
            "unmatched_completions": list(unmatched)}


def ledger(outcome="delivered", case="case-1", first=5, status=202, mismatch=False,
           triple=OPEN_T, detected=None):
    # case is an invented opaque string: no real case id exists. The writer sets
    # first_recorded_at and recorded_at to now() on first insert, so they are
    # equal on a real row. The demo's stub sink answers 202.
    seen = ns(t(first if detected is None else detected))
    return {"route": "to-case-desk",
            "event_id": egress_event_id(*triple, EGRESS_TIER, seen),
            "outcome": outcome,
            "http_status": status if outcome == "delivered" else None, "case_id": case,
            "episode_id": egress_id(*triple),
            "recorded_at": t(first).isoformat(), "first_recorded_at": t(first).isoformat(),
            "case_id_mismatch": mismatch}


ATL_LABELS = {"originator_nation": "ATL", "releasable_to": []}
BDR_LABELS = {"originator_nation": "BDR", "releasable_to": []}
NO_LABELS = {"originator_nation": None, "releasable_to": []}


# Intake records are invented values: no real action or completion record exists.
# An action's case id equals the ledger row's case_id.
def released(case="case-1", allowed=True, reason=None, minute=20, labels=ATL_LABELS,
             key="act-1"):
    return {"kind": "ActionRecord", "key": key, "case_id": case,
            "decided_at": t(minute).isoformat(), "allowed": allowed, "reason": reason,
            "labels": labels}


def completion(outcome="done", episode=None, minute=30, key="done-1", labels=ATL_LABELS,
               completes="act-1"):
    # The id OpenDDIL sent is the egress-side one.
    return {"kind": "Completion", "key": key, "completes": completes,
            "decided_at": t(minute).isoformat(), "allowed": True, "reason": None,
            "outcome": outcome,
            "episode_id_carried": episode or egress_id(*OPEN_T), "labels": labels}


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
    assert rep(mine(env), E_OPEN)["owning_tier"] == TIER
    code, body = get(env[1] + "/reports/tier", "supervisor-b")
    assert code == 200 and body["reports"]
    assert state.non_get == []
    assert all(r["table"] in ("failure_episodes", "asset_cm_state")
               for r in state.electric_requests)
    assert state.pane_calls and all(p.startswith("/reports/states?") for p in state.pane_calls)
    assert all("episode_id" not in q for q in state.pane_queries)


# ---- check 3: every state --------------------------------------------------
def test_check3_filed_open_and_closed(env):
    body = mine(env)
    o = rep(body, E_OPEN)
    assert o["open"] is True and o["cleared_at"] is None
    f = state_of(o, "filed")
    assert f["at"] == t(61).isoformat() and "cleared_by" not in f["detail"]
    c = rep(body, E_CLOSED)
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
    o = rep(mine(env), E_OPEN)
    assert "queued for send" in names(o) and "sent" not in names(o)
    assert state_of(o, "queued for send")["detail"]["ledger"] == "no row"


def test_check3_queued_when_held_with_retries_exhausted(env):
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger(outcome="held", case=None)])
    q = state_of(rep(mine(env), E_OPEN), "queued for send")
    assert q["detail"]["held"] == "retries exhausted"


def test_check3_sent_and_case_opened(env):
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger(mismatch=True)])
    o = rep(mine(env), E_OPEN)
    assert "queued for send" not in names(o)
    s = state_of(o, "sent")["detail"]
    assert s["http_status"] == 202 and s["recorded_at"] == t(5).isoformat()
    co = state_of(o, "case opened")["detail"]
    assert co["case_id"] == "case-1" and co["case_id_mismatch"] is True


def test_check3_delivered_without_a_case_id_is_sent_awaiting_reply(env):
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger(case=None)])
    o = rep(mine(env), E_OPEN)
    assert "sent, awaiting reply" in names(o) and "case opened" not in names(o)


def test_check3_proposed_and_approved_are_read_in_3b(env):
    o = rep(mine(env), E_OPEN)
    for name in ("proposed", "approved"):
        s = state_of(o, name)
        assert s["source"] == "iagent" and s["at"] is None
        assert s["detail"] == {"read": "read in 3b"}


def test_check3_released_admitted_and_refused(env):
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released()])
    r = state_of(rep(mine(env), E_OPEN), "released")
    assert r["at"] == t(20).isoformat() and r["detail"]["allowed"] is True
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()],
        released=[released(allowed=False, reason="schema_invalid")])
    pep, _ = env
    pep._reports_cache.clear()
    r = state_of(rep(mine(env), E_OPEN), "released")
    assert r["detail"]["allowed"] is False and r["detail"]["reason"] == "schema_invalid"


def test_check3_work_recorded_no_source_while_undeclared(env):
    w = state_of(rep(mine(env), E_OPEN), "work recorded")
    assert w["detail"] == {"read": "no source"} and w["at"] is None


def declared(env, *records, unmatched=()):
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released()], declared=True,
        records=records, unmatched=unmatched)
    return rep(mine(env), E_OPEN)


def test_check3_work_recorded_matched_with_its_time(env):
    # The completion carries the egress-side id, which is not the report's id.
    assert egress_id(*OPEN_T) != E_OPEN
    w = state_of(declared(env, completion()), "work recorded")
    assert w["at"] == t(30).isoformat() and "episode_mismatch" not in w["detail"]


def test_check3_work_recorded_cancelled_leaves_the_episode_as_it_was(env):
    o = declared(env, completion(outcome="cancelled"))
    assert "work recorded: cancelled" in names(o)
    assert o["open"] is True and o["cleared_at"] is None


def test_check3_work_recorded_deferred(env):
    assert "work recorded: deferred" in names(declared(env, completion(outcome="deferred")))


def test_check3_work_recorded_episode_mismatch(env):
    w = state_of(declared(env, completion(episode=egress_id(ASSET_A, "other", "F-9"))),
                 "work recorded")
    assert w["detail"]["episode_mismatch"] is True


def test_check3_a_completion_carrying_the_cm_service_id_is_a_mismatch(env):
    # The id the report is listed under is not the id OpenDDIL sent.
    w = state_of(declared(env, completion(episode=E_OPEN)), "work recorded")
    assert w["detail"]["episode_mismatch"] is True


def test_check3_unmatched_completion_is_listed_under_the_report(env):
    stray = completion(key="stray-1")
    stray["completes"] = "act-elsewhere"
    o = declared(env, unmatched=[stray])
    assert [u["key"] for u in o["unmatched"]] == ["stray-1"]
    assert "work recorded" not in [s["state"] for s in o["states"] if s["source"] == "intake"]


def test_check3_door_unreachable_replaces_the_hub_states(env):
    state.pane_mode = "500"
    o = rep(mine(env), E_OPEN)
    assert "door at the hub, unreachable" in names(o)
    assert not {"queued for send", "sent", "released", "work recorded"} & set(names(o))
    assert "filed" in names(o)


def test_check3_door_unreachable_on_connection_refused(env):
    pep, url = env
    pep.EGRESS_PANE = "http://127.0.0.1:9"
    assert "door at the hub, unreachable" in names(rep(mine(env), E_OPEN))


def test_check3_no_pane_configured(env):
    pep, _ = env
    pep.EGRESS_PANE = ""
    o = rep(mine(env), E_OPEN)
    assert "door not configured at this tier" in names(o)
    assert "queued for send" not in names(o)


# ---- check 4: the filer ----------------------------------------------------
def test_check4_two_sources_list_for_both_filers(env):
    assert rep(mine(env, "maintainer-a"), E_CLOSED)
    assert rep(mine(env, "maintainer-b"), E_CLOSED)


def test_check4_a_filer_sees_only_their_own_subject_in_the_detail(env):
    d = state_of(rep(mine(env, "maintainer-b"), E_CLOSED), "filed")["detail"]
    assert d["reported_by"] == ["maintainer-b"] and d["sources"] == 2


def test_check4_viewer_in_no_sources_gets_an_empty_list_with_the_state(env):
    body = mine(env, "maintainer-c")
    assert body["reports"] == [] and body["state"] == "no reports filed by you"


def test_check4_shared_id_joins_ledger_rows_by_interval(env):
    # E-DUP closed [40, 100); open one detected at 120.
    state.pane_episodes[E_DUP] = pane_block(triple=DUP_T, ledger=[
        ledger(case="case-old", first=50, triple=DUP_T),
        ledger(case="case-new", first=130, triple=DUP_T)])
    body = mine(env)
    old = rep(body, E_DUP, open_=False)
    new = rep(body, E_DUP, open_=True)
    assert state_of(old, "case opened")["detail"]["case_id"] == "case-old"
    assert state_of(new, "case opened")["detail"]["case_id"] == "case-new"
    assert body["unmatched_ledger"] == []


def test_check4_a_row_that_fits_neither_is_listed_never_dropped(env):
    # 110 falls in the gap [100, 120).
    state.pane_episodes[E_DUP] = pane_block(
        triple=DUP_T, ledger=[ledger(case="case-gap", first=110, triple=DUP_T)])
    body = mine(env)
    assert [u["case_id"] for u in body["unmatched_ledger"]] == ["case-gap"]
    assert all("case opened" not in names(r) for r in body["reports"] if r["episode_id"] == E_DUP)


def test_check4_a_late_row_for_a_single_episode_still_joins_it(env):
    # E-CLOSED cleared at 30; a held row delivered at 90 is still its row.
    state.pane_episodes[E_CLOSED] = pane_block(
        triple=CLOSED_T, ledger=[ledger(first=90, triple=CLOSED_T)])
    body = mine(env)
    assert "case opened" in names(rep(body, E_CLOSED))
    assert body["unmatched_ledger"] == []


# ---- check 5: a supervisor's reports at the tier ---------------------------
def test_check5_supervisor_sees_the_tier_through_the_label_rule(env):
    code, body = get(env[1] + "/reports/tier", "supervisor-b")
    assert code == 200
    ids = {r["episode_id"] for r in body["reports"]}
    assert {E_OPEN, E_CLOSED, E_DUP} <= ids
    # The planted episode carries a label the supervisor lacks.
    assert E_BDR not in ids
    # Another tier's episodes are never listed.
    assert E_OTHER_TIER not in ids and E_ELSEWHERE not in ids
    # A supervisor's list names every filer.
    d = state_of(rep(body, E_CLOSED), "filed")["detail"]
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
    assert E_ELSEWHERE in {r["episode_id"] for r in body["reports"]}
    assert rep(body, E_ELSEWHERE)["owning_tier"] == "edge-other"


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


def test_the_pane_is_called_once_per_request_with_asset_ids_only(env):
    mine(env)
    assert len(state.pane_calls) == 1
    q = urllib.parse.parse_qs(urllib.parse.urlparse(state.pane_calls[0]).query)
    assert q == {"asset_id": [ASSET_A]}


def test_a_pane_block_for_a_fault_no_listed_episode_holds_is_skipped(env):
    state.pane_episodes["stray"] = pane_block(
        triple=(ASSET_A, "comp-x", "F-x"),
        ledger=[ledger(case="case-stray", triple=(ASSET_A, "comp-x", "F-x"))])
    body = mine(env)
    assert body["unmatched_ledger"] == []
    assert all("case opened" not in names(r) for r in body["reports"])


# ---- the join: the ledger's id is not cm-service's id ------------------------
REAL_T = (ASSET_B, "radar", "F-9")


def real_world():
    rid, eid = cm_id(*REAL_T), egress_id(*REAL_T)
    assert rid != eid
    return {"asset_cm_state": [cm_row(ASSET_B, TIER, [
                {"discrepancy_id": rid, "detected_at_ns": ns(t(60)), "component": "radar",
                 "fault_code": "F-9", "sources": [source("maintainer-a", 61)]}])],
            "failure_episodes": []}


@pytest.mark.parametrize("case_id,reply_state", [
    (None, "sent, awaiting reply"), ("case-9", "case opened")])
def test_a_delivered_row_with_a_different_id_joins_by_the_fault(env, case_id, reply_state):
    state.world = real_world()
    state.pane_episodes["b"] = pane_block(
        triple=REAL_T, ledger=[ledger(case=case_id, triple=REAL_T)])
    body = mine(env)
    r = rep(body, cm_id(*REAL_T))
    assert egress_id(*REAL_T) != r["episode_id"]
    assert "queued for send" not in names(r)
    assert names(r)[names(r).index("sent"):][:2] == ["sent", reply_state]
    assert body["unmatched_ledger"] == []
    assert parse_pane_query(state)["asset_id"] == [ASSET_B]


def parse_pane_query(st):
    return st.pane_queries[-1]


def test_a_row_of_another_fault_on_the_asset_does_not_join(env):
    state.world = real_world()
    other = (ASSET_B, "radar", "F-10")
    state.pane_episodes["b"] = pane_block(triple=other, ledger=[ledger(triple=other)])
    r = rep(mine(env), cm_id(*REAL_T))
    assert "sent" not in names(r) and "queued for send" in names(r)


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
    assert rep(body, E_AT_U, open_=True)["owning_tier"] == "edge-u"
    assert rep(body, E_AT_U, open_=False)["owning_tier"] == "edge-u"
    assert rep(body, E_AT_R)["owning_tier"] == "region-r"
    assert rep(body, E_AT_T)["owning_tier"] == "edge-t"


@SHAPE
def test_check5_case2_the_label_rule_applies_to_a_row_below(env, ignore_where):
    body = tier_at(env, "region-r", ignore_where)
    ids = {r["episode_id"] for r in body["reports"]}
    # The same edge's other closed episode is listed, so the row is in scope
    # and only the label rule removes it.
    assert E_AT_U in ids
    assert E_AT_U_BDR not in ids
    pep, _ = env
    assert any(e["episode_id"] == E_AT_U_BDR for e in pep.report_episodes())


@SHAPE
def test_check5_case3_a_region_does_not_see_a_sibling_region(env, ignore_where):
    body = tier_at(env, "region-r", ignore_where)
    ids = {r["episode_id"] for r in body["reports"]}
    assert E_AT_S not in ids and E_AT_V not in ids


@SHAPE
def test_check5_case4_an_edge_does_not_see_its_region_or_a_sibling_edge(env, ignore_where):
    body = tier_at(env, TIER, ignore_where)
    ids = {r["episode_id"] for r in body["reports"]}
    assert E_AT_R not in ids and E_AT_U not in ids
    assert rep(body, E_AT_T)["owning_tier"] == TIER


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


# ---- the label rule on the action states; the unjoinable-ledger count ----------
def shared_world():
    """E-OPEN filed by the ATL-only, BDR-only and every-nation viewers.

    The row is releasable to BDR as well: /reports/mine applies the label
    rule, so every filer here must be able to see the episode they filed.
    """
    srcs = [source(w, 61) for w in ("maintainer-a", "filer-bdr", "filer-all")]
    state.world = {"asset_cm_state": [
        cm_row(ASSET_A, TIER, [open_ep(E_OPEN, 60, srcs)], releasable="{BDR}")],
        "failure_episodes": []}


VIEWERS = ("maintainer-a", "filer-bdr", "filer-all")


def raw_mine(env, subject):
    req = urllib.request.Request(env[1] + "/reports/mine")
    req.add_header("X-OpenDDIL-Subject", subject)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read()


def only_state(env, subject, name_prefix):
    pep, _ = env
    pep._reports_cache.clear()
    return [s for s in rep(mine(env, subject), E_OPEN)["states"]
            if s["state"].startswith(name_prefix)]


def test_a_visible_released_record_renders_as_before(env):
    shared_world()
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger()], released=[released()])
    r = only_state(env, "maintainer-a", "released")[0]
    assert r["detail"]["key"] == "act-1" and r["at"] == t(20).isoformat()


def test_a_bdr_only_released_record_is_withheld_from_atl_and_shown_to_bdr(env):
    shared_world()
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()],
        released=[released(allowed=False, reason="schema_invalid", labels=BDR_LABELS)])
    (w,) = only_state(env, "maintainer-a", "disposition")
    assert w == {"state": "disposition withheld", "source": "intake", "at": None, "detail": {}}
    assert only_state(env, "maintainer-a", "released") == []
    (r,) = only_state(env, "filer-bdr", "released")
    assert r["detail"]["reason"] == "schema_invalid"


def test_an_unlabelled_released_record_is_withheld_from_every_nation(env):
    shared_world()
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released(labels=NO_LABELS)])
    (w,) = only_state(env, "filer-all", "disposition")
    assert w["detail"] == {} and w["at"] is None
    assert only_state(env, "filer-all", "released") == []


def test_a_released_record_with_no_labels_key_is_withheld(env):
    shared_world()
    rec = released()
    del rec["labels"]
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger()], released=[rec])
    assert len(only_state(env, "filer-all", "disposition withheld")) == 1


def test_a_hidden_completion_is_a_work_record_withheld_with_no_mismatch(env):
    shared_world()
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released()], declared=True,
        records=[completion(episode=E_OPEN, labels=BDR_LABELS)])
    (w,) = only_state(env, "maintainer-a", "work record")
    assert w == {"state": "work record withheld", "source": "intake", "at": None, "detail": {}}
    assert only_state(env, "maintainer-a", "work recorded") == []
    (v,) = only_state(env, "filer-bdr", "work recorded")
    assert v["detail"]["episode_mismatch"] is True


def test_unmatched_completions_are_withheld_or_whitelisted(env):
    shared_world()
    hidden = completion(key="stray-1", labels=BDR_LABELS)
    shown = completion(key="stray-2")
    shown["nation_counts"] = {"BDR": 4}
    for u in (hidden, shown):
        u["completes"] = "act-elsewhere"
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released()], declared=True,
        unmatched=[hidden, shown])
    pep, _ = env
    got = rep(mine(env, "maintainer-a"), E_OPEN)["unmatched"]
    assert got[0] == {"withheld": True}
    assert got[1]["key"] == "stray-2"
    assert "nation_counts" not in got[1] and "labels" not in got[1]
    pep._reports_cache.clear()
    got = rep(mine(env, "filer-bdr"), E_OPEN)["unmatched"]
    assert got[0]["key"] == "stray-1" and got[1] == {"withheld": True}


def test_no_label_field_leaves_the_route(env):
    shared_world()
    # Episode-level fields do not use these names, so the whole body is checked.
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()],
        released=[released(), released(key="act-2", labels=BDR_LABELS)],
        declared=True,
        records=[completion(), completion(key="done-2", completes="act-2", labels=BDR_LABELS)],
        unmatched=[completion(key="s", labels=BDR_LABELS)])
    pep, _ = env
    for who in VIEWERS:
        pep._reports_cache.clear()
        raw = raw_mine(env, who)
        for word in (b"labels", b"originator_nation", b"releasable_to"):
            assert word not in raw, (who, word)


def decision_lines(caplog):
    out = []
    for r in caplog.records:
        msg = r.getMessage()
        if "DECISION " in msg:
            d = json.loads(msg.split("DECISION ", 1)[1])
            if d.get("resource") == "/reports/mine":
                out.append(d)
    return out


def test_withheld_is_in_the_log_and_not_in_the_body(env, caplog):
    import logging  # noqa: PLC0415
    caplog.set_level(logging.INFO)
    shared_world()
    stray = completion(key="s", labels=BDR_LABELS)
    stray["completes"] = "act-elsewhere"
    state.pane_episodes[E_OPEN] = pane_block(
        ledger=[ledger()], released=[released(labels=BDR_LABELS)],
        declared=True, records=[completion(labels=BDR_LABELS)], unmatched=[stray])
    body = mine(env, "maintainer-a")
    assert "withheld" not in body
    assert decision_lines(caplog)[-1]["withheld"] == 3


def test_unkeyed_ledger_count_is_returned_and_logged(env, caplog):
    import logging  # noqa: PLC0415
    caplog.set_level(logging.INFO)
    shared_world()
    state.pane_unkeyed = 3
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger()])
    body = mine(env, "maintainer-a")
    assert body["unkeyed_ledger"] == 3
    d = decision_lines(caplog)[-1]
    assert d["unkeyed_ledger"] == 3 and d["unmatched_ledger"] == len(body["unmatched_ledger"])
    warns = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING
             and "cannot be joined" in r.getMessage()]
    assert warns == ["reports: 3 ledger row(s) carry no component or fault_code "
                     "and cannot be joined"]


def test_unkeyed_ledger_zero_does_not_warn(env, caplog):
    import logging  # noqa: PLC0415
    caplog.set_level(logging.INFO)
    shared_world()
    state.pane_episodes[E_OPEN] = pane_block(ledger=[ledger()])
    assert mine(env, "maintainer-a")["unkeyed_ledger"] == 0
    assert not [r for r in caplog.records if "cannot be joined" in r.getMessage()]


def test_unkeyed_ledger_is_none_when_the_door_is_unreachable(env, caplog):
    import logging  # noqa: PLC0415
    caplog.set_level(logging.INFO)
    shared_world()
    state.pane_mode = "500"
    body = mine(env, "maintainer-a")
    assert body["unkeyed_ledger"] is None
    assert decision_lines(caplog)[-1]["unkeyed_ledger"] is None


# ---- the fixtures follow both id formulas -----------------------------------
def test_fixture_ids_follow_both_formulas():
    cm = cm_id(*OPEN_T)
    ep = egress_episode_id(*OPEN_T, EGRESS_TIER)
    ev = egress_event_id(*OPEN_T, EGRESS_TIER, ns(t(5)))
    assert cm != ep and ep != ev and cm != ev
    for one in (cm, ep, ev):
        assert uuid.UUID(one).version == 5
    # Every ledger item the builder produces by default keeps its own ids.
    item = ledger()
    assert item["event_id"] != item["episode_id"]
    assert uuid.UUID(item["event_id"]).version == 5
    assert uuid.UUID(item["episode_id"]).version == 5
    assert item["episode_id"] != cm
    assert item["first_recorded_at"] == item["recorded_at"]
    for other in (ledger(outcome="held", case=None), ledger(triple=DUP_T, first=50)):
        assert other["event_id"] != other["episode_id"]


# ---- a world shaped like the real hub ---------------------------------------
def test_a_world_shaped_like_the_real_hub(env):
    """The shape a read-only probe of a real hub store found: 21 asset rows, 20
    labelled by the originator only, edge and region set on all; one open
    discrepancy; two delivered ledger rows with no case id; no intake rows; no
    closed episodes."""
    assets = [f"dis:9:1:{3000 + i}" for i in range(21)]
    triple = (assets[0], "radar_unit", "RDR-PWR-12")
    other = (assets[1], "radar_unit", "RDR-PWR-12")
    disc = open_ep(cm_id(*triple), 60, [source("maintainer-a", 61)],
                   component=triple[1], fault=triple[2])
    rows = [cm_row(a, TIER, [disc] if a == assets[0] else [], region="region-t")
            for a in assets]
    rows[20]["releasable_to"] = "{BDR}"   # the one row that is not originator-only
    assert sum(r["releasable_to"] == "{}" for r in rows) == 20
    assert all(r["edge_id"] and r["region_id"] and r["originator_nation"] for r in rows)
    state.world = {"asset_cm_state": rows, "failure_episodes": []}
    state.pane_episodes["mine"] = pane_block(
        triple=triple, ledger=[ledger(case=None, triple=triple)])
    state.pane_episodes["other"] = pane_block(
        triple=other, ledger=[ledger(case=None, triple=other)])
    other_event = state.pane_episodes["other"]["ledger"][0]["event_id"]

    body = mine(env)
    assert [r["episode_id"] for r in body["reports"]] == [cm_id(*triple)]
    r = body["reports"][0]
    assert "sent" in names(r) and "case opened" not in names(r)
    assert not [n for n in names(r) if n.startswith("disposition")]
    assert body["unkeyed_ledger"] == 0
    assert body["unmatched_ledger"] == []
    assert other_event not in json.dumps(body)
    assert parse_pane_query(state)["asset_id"] == [assets[0]]
