"""Tests for POST /manual/ask: a maintainer's question, delegated through
this gateway to the manual question service and answered only when the
reply's citations stay inside the scope the request asked about.

Follows test_pep_cm_write.py's and test_pep_egress_route.py's shape: fake
Topaz/Electric/upstream servers on loopback, a module-scoped pep_factory
that sets env vars before importing pep.py (which reads its config at
import time), and a fresh Pep instance served per test.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

# Who the fake PDP knows. "pdp-down" makes Topaz answer 500.
ENTITLEMENTS = {"op.atl": ["ATL"], "stranger": []}

GOOD_DMC = "DMC-ODMRAD-A-34-10-01-00A-421A-A"
OUTSIDE_DMC = "DMC-ODMRAD-A-34-10-01-00A-520A-A"

state = {
    "visibility_rows": [
        {"asset_id": "atl-1", "platform_variant": "MRAD_Sensor",
         "installed": [{"slot_id": "ENG-1"}]},
    ],
    "manual_calls": [],
    "manual_reply": {"answer": "Reseat the connector.",
                      "citations": [{"dmc": GOOD_DMC, "step": "Reseat connector"}]},
    "manual_status": 200,
}


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


_ASSET_ID_IN_WHERE = re.compile(r"asset_id = '([^']*)'")


class FakeElectric(BaseHTTPRequestHandler):
    """Answers the bounded shape read the visibility check makes, reaching
    up to date on the first response -- the same fake test_pep_cm_write.py
    uses for the same purpose; see that file for the fuller rationale."""

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        where = (params.get("where") or [""])[0]
        match = _ASSET_ID_IN_WHERE.search(where)
        asset_id = match.group(1) if match else None
        rows = [row for row in state["visibility_rows"]
                if asset_id is None or row.get("asset_id") == asset_id]
        messages = [{"key": row.get("asset_id", "row"), "value": row,
                     "headers": {"operation": "insert"}} for row in rows]
        messages.append({"headers": {"control": "up-to-date"}})
        out = json.dumps(messages).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", "fake-handle")
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)


class FakeManualQa(BaseHTTPRequestHandler):
    """Stands in for the manual question service itself -- not the stub in
    gateway/manual_qa_stub.py, which has its own test. Records every
    request body it receives so tests can check what the gateway forwarded,
    and answers with whatever state["manual_reply"]/state["manual_status"]
    says."""

    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        state["manual_calls"].append(body)
        status = state["manual_status"]
        out = json.dumps(state["manual_reply"]).encode()
        self.send_response(status)
        if status == 200:
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        else:
            self.send_header("Content-Length", "0")
            self.end_headers()


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_factory():
    topaz = _serve(FakeTopaz)
    electric = _serve(FakeElectric)
    manual = _serve(FakeManualQa)

    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ["OPENDDIL_MANUAL_QA_URL"] = f"http://127.0.0.1:{manual.server_port}/ask"
    os.environ.pop("OPENDDIL_MANUAL_QA_TOKEN_FILE", None)
    os.environ.pop("OPENDDIL_CM_INTAKE_URL", None)
    os.environ.pop("OPENDDIL_FAULT_CATALOG_PATH", None)
    os.environ.pop("OPENDDIL_FAULT_CODES_PATH", None)
    os.environ.pop("OPENDDIL_REPORT_SOURCE", None)
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    sys.modules.pop("manual_qa", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"

    servers = []

    def start():
        srv = _serve(pep.Pep)
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_port}", pep

    yield start
    for s in servers + [topaz, electric, manual]:
        s.shutdown()
    os.environ.pop("OPENDDIL_MANUAL_QA_URL", None)


def _post(url: str, subject: str | None, body) -> tuple:
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


@pytest.fixture
def pep_url(pep_factory):
    state.update(
        visibility_rows=[
            {"asset_id": "atl-1", "platform_variant": "MRAD_Sensor",
             "installed": [{"slot_id": "ENG-1"}]},
        ],
        manual_calls=[],
        manual_reply={"answer": "Reseat the connector.",
                      "citations": [{"dmc": GOOD_DMC, "step": "Reseat connector"}]},
        manual_status=200,
    )
    return pep_factory()


GOOD_BODY = {"asset_id": "atl-1", "question": "What does fault code FC-100 mean?",
             "dmcs": [GOOD_DMC]}


def test_unset_upstream_is_404_and_upstream_not_called(pep_url):
    url, pep = pep_url
    saved = pep.MANUAL_QA_URL
    pep.MANUAL_QA_URL = ""
    try:
        code, _body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    finally:
        pep.MANUAL_QA_URL = saved
    assert code == 404
    assert state["manual_calls"] == []


def test_no_session_is_401(pep_url):
    url, _pep = pep_url
    code, _body = _post(url + "/manual/ask", None, GOOD_BODY)
    assert code == 401
    assert state["manual_calls"] == []


def test_pdp_down_is_503(pep_url):
    url, _pep = pep_url
    code, _body = _post(url + "/manual/ask", "pdp-down", GOOD_BODY)
    assert code == 503
    assert state["manual_calls"] == []


def test_pdp_deny_is_403(pep_url):
    url, _pep = pep_url
    code, _body = _post(url + "/manual/ask", "stranger", GOOD_BODY)
    assert code == 403
    assert state["manual_calls"] == []


def test_bad_dmc_shape_is_400(pep_url):
    url, _pep = pep_url
    body = dict(GOOD_BODY, dmcs=["not-a-dmc"])
    code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 400
    assert state["manual_calls"] == []


def test_question_too_long_is_400(pep_url):
    url, _pep = pep_url
    body = dict(GOOD_BODY, question="x" * 1001)
    code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 400
    assert state["manual_calls"] == []


def test_too_many_dmcs_is_400(pep_url):
    url, _pep = pep_url
    body = dict(GOOD_BODY, dmcs=[GOOD_DMC] * 21)
    code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 400
    assert state["manual_calls"] == []


def test_asset_not_visible_is_404(pep_url):
    url, _pep = pep_url
    body = dict(GOOD_BODY, asset_id="not-visible-1")
    code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 404
    assert state["manual_calls"] == []


def test_good_reply_is_answered(pep_url):
    url, _pep = pep_url
    code, body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    assert code == 200
    assert body == {"status": "answered", "answer": "Reseat the connector.",
                     "citations": [{"dmc": GOOD_DMC, "step": "Reseat connector"}]}


def test_out_of_scope_citation_is_no_cited_answer(pep_url):
    url, _pep = pep_url
    state["manual_reply"] = {"answer": "Reseat the connector.",
                              "citations": [{"dmc": OUTSIDE_DMC, "step": "Reseat connector"}]}
    code, body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    assert code == 200
    assert body == {"status": "no_cited_answer", "reason": "citation_outside_scope"}


def test_empty_citations_is_no_cited_answer(pep_url):
    url, _pep = pep_url
    state["manual_reply"] = {"answer": "Not sure.", "citations": []}
    code, body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    assert code == 200
    assert body == {"status": "no_cited_answer", "reason": "no_citations"}


def test_malformed_reply_is_no_cited_answer(pep_url):
    url, _pep = pep_url
    state["manual_reply"] = {"answer": "Not sure."}  # citations field missing entirely
    code, body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    assert code == 200
    assert body == {"status": "no_cited_answer", "reason": "malformed_reply"}


def test_upstream_failure_is_502(pep_url):
    url, _pep = pep_url
    state["manual_status"] = 500
    code, body = _post(url + "/manual/ask", "op.atl", GOOD_BODY)
    assert code == 502
    assert body == {"status": "unavailable"}


def test_on_behalf_of_is_the_session_subject_not_the_body(pep_url):
    url, _pep = pep_url
    body = dict(GOOD_BODY, on_behalf_of="someone-else")
    code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 200
    assert len(state["manual_calls"]) == 1
    assert state["manual_calls"][0]["on_behalf_of"] == "op.atl"


def test_question_text_never_appears_in_the_decision_log(pep_url, caplog):
    url, _pep = pep_url
    distinctive = "the quick brown fox fault code FC-100 question text"
    body = dict(GOOD_BODY, question=distinctive)
    with caplog.at_level("INFO"):
        code, _body = _post(url + "/manual/ask", "op.atl", body)
    assert code == 200
    assert distinctive not in caplog.text
