"""The /egress/decisions route, run through the real PEP handler.

test_egress_view.py checks the filter rule. This checks that the route
APPLIES it, and that every branch which cannot apply it refuses instead of
passing the pane's answer through: no subject, the PDP down, the pane
broken. pep.py reads its upstreams at import, so they are fakes on loopback
started before the import, and the PEP runs in header mode (no issuer set).

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

PANE_RECORDS = [
    {"asset_id": "atl-1", "originator_nation": "ATL", "releasable_to": [],
     "allowed": True, "reason": None, "decision_id": "dec-1"},
    {"asset_id": "atl-2", "originator_nation": "ATL", "releasable_to": [],
     "allowed": False, "reason": "no_nation_overlap", "decision_id": "dec-2"},
    {"asset_id": "bdr-1", "originator_nation": "BDR", "releasable_to": [],
     "allowed": False, "reason": "no_nation_overlap", "decision_id": "dec-3"},
    {"asset_id": "bdr-rel-atl", "originator_nation": "BDR", "releasable_to": ["ATL"],
     "allowed": True, "reason": None, "decision_id": "dec-4"},
    {"asset_id": "unlabelled", "originator_nation": None, "releasable_to": [],
     "allowed": False, "reason": "unlabelled", "decision_id": "dec-5"},
]

# Who the fake PDP knows. "pdp-down" makes Topaz answer 500.
ENTITLEMENTS = {"op.atl": ["ATL"], "op.bdr": ["BDR"], "regional": ["ATL", "BDR"]}

state = {"pane": "ok", "pane_calls": 0, "pane_query": None, "cases_body": None}


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
        nations = ENTITLEMENTS.get(subject, [])
        x = {"allow": bool(nations), "allowed_nations": nations,
             "subject_known": subject in ENTITLEMENTS,
             "policy_version": "p1", "corpus_version": "c1", "role": "edge-operator"}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakePane(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        state["pane_calls"] += 1
        state["pane_query"] = self.path
        mode = state["pane"]
        if self.path.startswith("/cases") and state["cases_body"] is not None:
            status, body = 200, state["cases_body"]
        elif mode == "ok":
            status, body = 200, {"destination": "system:x", "policy_version": "p1",
                                 "corpus_version": "c1", "admitted": 2, "refused": 3,
                                 "fleet_summary": {"BDR": 2},
                                 "records": PANE_RECORDS}
        elif mode == "503":
            status, body = 503, {"error": "authz_unavailable", "detail": "pdp down"}
        else:
            status, body = 500, {"error": "boom"}
        out = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_factory():
    topaz, pane = _serve(FakeTopaz), _serve(FakePane)
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:9"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    # HEADER MODE, PINNED. `oidc` reads its issuer once at import, and an
    # earlier test module may already have imported it with one set.
    pep.AUTH_MODE = "header"

    servers = []

    def start(pane_url: str):
        pep.EGRESS_PANE = pane_url
        srv = _serve(pep.Pep)
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_port}"

    yield start, f"http://127.0.0.1:{pane.server_port}"
    for s in servers + [topaz, pane]:
        s.shutdown()


def _get(url: str, subject: str | None):
    req = urllib.request.Request(url)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


@pytest.fixture
def pep_url(pep_factory):
    start, pane = pep_factory
    state.update(pane="ok", pane_calls=0, pane_query=None, cases_body=None)
    return start(pane)


Q = "/egress/decisions?destination=system%3Ax&where=1%3D1"


def _ids(body):
    return [r["asset_id"] for r in body["records"]]


def test_atl_viewer_sees_only_atl_visible_records(pep_url):
    code, body, headers = _get(pep_url + Q, "op.atl")
    assert code == 200
    assert _ids(body) == ["atl-1", "atl-2", "bdr-rel-atl"]
    # withheld == 1, not 2: PANE_RECORDS has exactly one unlabelled record
    # ("unlabelled"); bdr-1 is hidden from this ATL viewer too, but it is
    # LABELLED (originator BDR), so it must not be counted here -- that
    # would tell an ATL-only viewer how many BDR records exist, the leak
    # AccessDenied.tsx rules out.
    assert (body["admitted"], body["refused"], body["withheld"]) == (2, 1, 1)
    assert body["viewer_nations"] == ["ATL"]
    assert "fleet_summary" not in body
    assert headers.get("Cache-Control") == "no-store"


def test_bdr_viewer_sees_only_bdr_records(pep_url):
    code, body, _ = _get(pep_url + Q, "op.bdr")
    assert code == 200
    assert _ids(body) == ["bdr-1", "bdr-rel-atl"]
    # Same one unlabelled record -- not 3 (the old total-minus-shown count
    # of every ATL record hidden from this BDR viewer).
    assert body["withheld"] == 1


def test_unlabelled_is_withheld_even_from_every_nation(pep_url):
    code, body, _ = _get(pep_url + Q, "regional")
    assert code == 200
    assert "unlabelled" not in _ids(body)
    assert body["withheld"] == 1


def test_only_destination_reaches_the_pane(pep_url):
    _get(pep_url + Q, "op.atl")
    assert state["pane_query"] == "/decisions?destination=system%3Ax"


def test_no_subject_is_401_and_the_pane_is_not_asked(pep_url):
    code, body, _ = _get(pep_url + Q, None)
    assert code == 401
    assert "records" not in body
    assert state["pane_calls"] == 0


def test_unknown_subject_is_403(pep_url):
    code, body, _ = _get(pep_url + Q, "stranger")
    assert code == 403
    assert "records" not in body
    assert state["pane_calls"] == 0


def test_pdp_down_is_503_and_the_pane_is_not_asked(pep_url):
    code, body, _ = _get(pep_url + Q, "pdp-down")
    assert code == 503
    assert "records" not in body
    assert state["pane_calls"] == 0


def test_pane_failure_is_502_with_no_records(pep_url):
    state["pane"] = "500"
    code, body, _ = _get(pep_url + Q, "op.atl")
    assert code == 502
    assert body == {"error": "egress pane unavailable"}


def test_pane_pdp_outage_is_relayed_as_503(pep_url):
    state["pane"] = "503"
    code, body, _ = _get(pep_url + Q, "op.atl")
    assert code == 503
    assert body["detail"] == "pdp down"


def test_no_pane_at_this_tier_is_404(pep_factory):
    start, _ = pep_factory
    url = start("")
    code, body, _ = _get(url + Q, "op.atl")
    assert code == 404
    assert "records" not in body


def test_kind_is_forwarded_to_the_pane(pep_url):
    code, _, _ = _get(
        pep_url + "/egress/decisions?destination=system%3Ax&kind=records.v1",
        "op.atl",
    )
    assert code == 200
    assert state["pane_query"] == "/decisions?destination=system%3Ax&kind=records.v1"


def test_absent_kind_forwards_only_destination(pep_url):
    _get(pep_url + Q, "op.atl")
    assert state["pane_query"] == "/decisions?destination=system%3Ax"


def test_blank_kind_is_treated_as_absent(pep_url):
    code, _, _ = _get(pep_url + "/egress/decisions?destination=system%3Ax&kind=", "op.atl")
    assert code == 200
    assert state["pane_query"] == "/decisions?destination=system%3Ax"


@pytest.mark.parametrize("bad_kind", ["has space", "slash/es", "semi;colon"])
def test_invalid_kind_is_denied_before_the_pane_is_asked(pep_url, bad_kind):
    code, body, _ = _get(
        pep_url + "/egress/decisions?destination=system%3Ax&kind="
        + urllib.parse.quote(bad_kind, safe=""),
        "op.atl",
    )
    assert code == 400
    assert body["cause"] == "invalid kind"
    assert state["pane_calls"] == 0


# The ids a fault carries. KIND is invented: the real kind name is deployment
# config. The formulas are the real ones: cm-service names an episode by
# "episode|asset|component|fault_code"; the egress assembler names the episode by
# "kind|tier|asset|component|fault_code" and each occurrence (the event id) by
# the same seed plus the detected time in ns. Real ids are uuid v5 and the three
# differ, so no fixture here may use one literal for two of them.
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


# --- /egress/cases: same gate as /egress/decisions ---------------------------

ASSET = "dis:9:1:2001"
CQ = "/egress/cases?asset_id=" + urllib.parse.quote(ASSET, safe="")


def _cm(asset_id, originator, releasable_to=None, edge_id="edge-01", region_id="region-east"):
    """One asset_cm_state row as the cached shape returns it (arrays arrive as
    Postgres literals)."""
    rel = "{" + ",".join(releasable_to or []) + "}"
    return {"asset_id": asset_id, "originator_nation": originator,
            "releasable_to": rel, "edge_id": edge_id, "region_id": region_id}


def _cases_env(monkeypatch, rows, tier="hub", body=None):
    """Stub the PEP's cached asset_cm_state read and pin the tier."""
    pep = sys.modules["pep"]
    monkeypatch.setattr(pep, "PEP_TIER", tier)
    if isinstance(rows, Exception):
        def boom(table):
            raise rows
        monkeypatch.setattr(pep, "_reports_rows", boom)
    else:
        monkeypatch.setattr(pep, "_reports_rows", lambda table: rows)
    state["cases_body"] = body


def _case(case_id, action_labels, state_="admitted"):
    # case_id is an invented opaque string: no real case id exists (the receiver
    # answered with none), so nothing here shapes it. The ids around it are real
    # uuid v5 values; the detected time is invented, one per case.
    asset, comp, fault = ASSET, "radar_unit", "RDR-PWR-12"
    detected_ns = 1_793_000_000_000_000_000 + zlib.crc32(case_id.encode())
    return {"route": "to-case-desk", "case_id": case_id,
            "episode_id": egress_episode_id(asset, comp, fault, "hub"),
            "event_id": egress_event_id(asset, comp, fault, "hub", detected_ns),
            "asset_id": asset, "component": comp, "fault_code": fault,
            "delivered_at": "2026-11-20T10:00:00+00:00",
            "disposition": {"option": "swap", "stage": "approver", "kind": "action.v1",
                            "key": "k-" + case_id},
            "decided_at": "2026-11-20T11:00:00+00:00",
            "decision": {"allowed": True, "reason": None},
            "disposition_state": state_, "action_labels": action_labels}


AQ = "/egress/cases?asset_id=" + urllib.parse.quote(ASSET, safe="")
ATL_ACTION = {"originator_nation": "ATL", "releasable_to": []}
BDR_ACTION = {"originator_nation": "BDR", "releasable_to": []}
NO_ACTION_LABELS = {"originator_nation": None, "releasable_to": []}


def _raw(url, subject):
    req = urllib.request.Request(url)
    req.add_header("X-OpenDDIL-Subject", subject)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read()


def _case_decisions(caplog):
    out = []
    for r in caplog.records:
        msg = r.getMessage()
        if "DECISION " in msg:
            d = json.loads(msg.split("DECISION ", 1)[1])
            if str(d.get("resource", "")).startswith("egress:cases:"):
                out.append(d)
    return out


def test_cases_entitled_viewer_reaches_the_pane_with_only_asset_id(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body={"cases": []})
    code, _, headers = _get(pep_url + CQ + "&where=1%3D1", "op.atl")
    assert code == 200
    assert state["pane_query"] == "/cases?asset_id=" + urllib.parse.quote(ASSET, safe="")
    assert headers.get("Cache-Control") == "no-store"


def test_cases_no_subject_is_401_unknown_is_403_pdp_down_is_503(pep_url):
    for subject, want in ((None, 401), ("stranger", 403), ("pdp-down", 503)):
        code, _, _ = _get(pep_url + CQ, subject)
        assert code == want
    assert state["pane_calls"] == 0


@pytest.mark.parametrize("q", ["", "?asset_id=", "?asset_id=has%20space"])
def test_cases_bad_asset_id_is_400_before_the_pane_is_asked(pep_url, q):
    code, _, _ = _get(pep_url + "/egress/cases" + q, "op.atl")
    assert code == 400
    assert state["pane_calls"] == 0


def test_cases_no_pane_at_this_tier_is_404(pep_factory):
    start, _ = pep_factory
    code, _, _ = _get(start("") + CQ, "op.atl")
    assert code == 404


# --- /egress/cases: the label rule ------------------------------------------


def test_cases_bdr_only_asset_reads_empty_and_the_pane_is_not_asked(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "BDR")], body={"cases": [_case("c1", ATL_ACTION)]})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert code == 200
    assert raw == b'{"cases": []}'
    assert state["pane_calls"] == 0


def test_cases_asset_released_to_the_viewer_shows_cases(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "BDR", ["ATL"])],
               body={"cases": [_case("c1", ATL_ACTION)]})
    code, body, _ = _get(pep_url + AQ, "op.atl")
    assert code == 200
    assert [c["case_id"] for c in body["cases"]] == ["c1"]
    assert body["cases"][0]["disposition_state"] == "admitted"
    assert state["pane_calls"] == 1


def test_cases_unlabelled_asset_reads_empty_even_for_every_nation(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, None)], body={"cases": [_case("c1", ATL_ACTION)]})
    code, raw = _raw(pep_url + AQ, "regional")
    assert (code, raw) == (200, b'{"cases": []}')
    assert state["pane_calls"] == 0


def test_cases_absent_asset_is_byte_identical_to_a_hidden_one(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "BDR")])
    _, hidden = _raw(pep_url + AQ, "op.atl")
    _cases_env(monkeypatch, [_cm("dis:9:1:2002", "ATL")])
    code, absent = _raw(pep_url + AQ, "op.atl")
    assert code == 200
    assert absent == hidden == b'{"cases": []}'
    assert state["pane_calls"] == 0


def test_cases_asset_row_out_of_tier_scope_is_not_visible(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "ATL", edge_id="edge-09", region_id="region-west")],
               tier="region-east", body={"cases": [_case("c1", ATL_ACTION)]})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert (code, raw) == (200, b'{"cases": []}')
    assert state["pane_calls"] == 0


def test_cases_hidden_action_is_withheld_and_counted_in_the_log_only(
        pep_url, monkeypatch, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="pep.decision")
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body={"cases": [
        _case("c-bdr", BDR_ACTION), _case("c-atl", ATL_ACTION)]})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert code == 200
    by_id = {c["case_id"]: c for c in json.loads(raw)["cases"]}
    hidden = by_id["c-bdr"]
    assert hidden["disposition_state"] == "withheld"
    assert hidden["disposition"] is None and hidden["decided_at"] is None
    assert hidden["decision"] == {"allowed": None, "reason": None}
    assert by_id["c-atl"]["disposition_state"] == "admitted"
    assert by_id["c-atl"]["disposition"]["option"] == "swap"
    assert set(json.loads(raw)) == {"cases"}
    lines = _case_decisions(caplog)
    assert lines[-1]["withheld"] == 1 and lines[-1]["shown"] == 2


def test_cases_unlabelled_action_is_withheld_for_everyone(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "ATL", ["BDR"])],
               body={"cases": [_case("c1", NO_ACTION_LABELS)]})
    for who in ("op.atl", "regional"):
        _, body, _ = _get(pep_url + AQ, who)
        assert body["cases"][0]["disposition_state"] == "withheld"
        assert body["cases"][0]["disposition"] is None


def test_cases_no_action_row_keeps_the_panes_reading(pep_url, monkeypatch):
    case = _case("c1", None, state_="none")
    case["disposition"], case["decided_at"] = None, None
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body={"cases": [case]})
    _, body, _ = _get(pep_url + AQ, "op.atl")
    assert body["cases"][0]["disposition_state"] == "none"


def test_cases_action_labels_never_leave_the_route(pep_url, monkeypatch):
    _cases_env(monkeypatch, [_cm(ASSET, "ATL", ["BDR"])], body={"cases": [
        _case("c1", ATL_ACTION), _case("c2", BDR_ACTION), _case("c3", NO_ACTION_LABELS),
        _case("c4", None)]})
    for who in ("op.atl", "op.bdr", "regional"):
        code, raw = _raw(pep_url + AQ, who)
        assert code == 200
        assert b"action_labels" not in raw
        assert b"originator_nation" not in raw and b"releasable_to" not in raw


def test_cases_answer_is_a_whitelist_no_other_pane_key_passes(pep_url, monkeypatch):
    # A summary key the pane might add later, computed over every nation's
    # cases, must not reach the viewer.
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body={
        "cases": [_case("c1", ATL_ACTION)], "nation_counts": {"BDR": 3}})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert code == 200
    assert set(json.loads(raw)) == {"cases"}


def test_cases_at_a_tier_every_case_is_held_at_the_hub_and_labels_are_stripped(
        pep_url, monkeypatch, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="pep.decision")
    _cases_env(monkeypatch, [_cm(ASSET, "ATL", edge_id="edge-01", region_id="region-east")],
               tier="edge-01", body={"cases": [
                   _case("c-bdr", BDR_ACTION), _case("c-atl", ATL_ACTION)]})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert code == 200
    cases = json.loads(raw)["cases"]
    assert {c["disposition_state"] for c in cases} == {"held at the hub"}
    assert all(c["disposition"] is None for c in cases)
    assert b"action_labels" not in raw
    assert _case_decisions(caplog)[-1]["withheld"] == 1


@pytest.mark.parametrize("body", [
    [], {"cases": "x"}, {"nope": 1}, {"cases": [1]},
    {"cases": [_case("c1", ATL_ACTION), "x"]}])
def test_cases_pane_body_not_the_shape_is_502(pep_url, monkeypatch, body):
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body=body)
    code, resp, _ = _get(pep_url + AQ, "op.atl")
    assert code == 502
    assert resp == {"error": "egress pane unavailable"}


def test_cases_electric_down_is_502_and_the_pane_is_not_asked(pep_url, monkeypatch):
    pep = sys.modules["pep"]
    _cases_env(monkeypatch, pep.ElectricUnavailable("electric unreachable"),
               body={"cases": [_case("c1", ATL_ACTION)]})
    code, resp, _ = _get(pep_url + AQ, "op.atl")
    assert code == 502
    assert resp == {"error": "cases unavailable"}
    assert state["pane_calls"] == 0


def test_cases_a_delivered_row_with_no_case_id_reads_empty(pep_url, monkeypatch):
    # The real default: the receiver answered with no case id, so the ledger row
    # is delivered with case_id NULL. The pane's /cases SQL keeps only rows with a
    # case id, so it answers no cases for this asset, and the route says so.
    _cases_env(monkeypatch, [_cm(ASSET, "ATL")], body={"cases": []})
    code, raw = _raw(pep_url + AQ, "op.atl")
    assert (code, raw) == (200, b'{"cases": []}')
    assert state["pane_calls"] == 1
