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
import urllib.request
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

state = {"pane": "ok", "pane_calls": 0, "pane_query": None}


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
        if mode == "ok":
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
    state.update(pane="ok", pane_calls=0, pane_query=None)
    return start(pane)


Q = "/egress/decisions?destination=system%3Ax&where=1%3D1"


def _ids(body):
    return [r["asset_id"] for r in body["records"]]


def test_atl_viewer_sees_only_atl_visible_records(pep_url):
    code, body, headers = _get(pep_url + Q, "op.atl")
    assert code == 200
    assert _ids(body) == ["atl-1", "atl-2", "bdr-rel-atl"]
    assert (body["admitted"], body["refused"], body["withheld"]) == (2, 1, 2)
    assert body["viewer_nations"] == ["ATL"]
    assert "fleet_summary" not in body
    assert headers.get("Cache-Control") == "no-store"


def test_bdr_viewer_sees_only_bdr_records(pep_url):
    code, body, _ = _get(pep_url + Q, "op.bdr")
    assert code == 200
    assert _ids(body) == ["bdr-1", "bdr-rel-atl"]
    assert body["withheld"] == 3


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
