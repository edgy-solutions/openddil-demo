"""GET /exercise/status and POST /exercise/op/<op>, run through the real
PEP handler.

This checks that both routes go through the gateway's subject-then-Topaz
sequence like /proxies/uplink (ADR-0029's WAN control route), that a role
other than the configured exercise-control role is refused with ZERO
requests reaching the fake exercise/control.py stand-in, that a
client-sent X-OpenDDIL-Subject is overwritten with the session's own
subject before forwarding, and that nothing under /exercise/ ever reaches
the fake service unless it is exactly one of the two routes.

pep.py reads its upstreams at import, so Topaz and the exercise-control
stand-in are fakes on loopback started before the import, and the PEP
runs in header mode -- same harness as test_pep_wan_control.py.

Run:  py -3 -m pytest gateway/test_pep_exercise_control.py -q
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

SUBJECT_ROLES = {
    "supervisor.1": "supervisor",
    "operator.1": "edge-operator",
}

state = {
    "calls": [],
    "status": 200,
    "body": b'{"adapter": {"name": "x", "ops": ["pause"]}, "last_command": null, '
            b'"activity": {"state": "unknown", "label": "measuring", "window_s": 30, '
            b'"min_rate": 0.1, "sources": []}, "reset": {"measured_zero_at": null, "verdict": null}}',
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
        role = SUBJECT_ROLES.get(subject)
        x = {
            "allow": True,
            "allowed_nations": [],
            "subject_known": role is not None,
            "policy_version": "p1",
            "corpus_version": "c1",
            "role": role or "observer",
        }
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeExerciseControl(BaseHTTPRequestHandler):
    """Stands in for exercise/control.py."""

    def log_message(self, *a):
        pass

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        state["calls"].append({
            "method": method,
            "path": self.path,
            "body": body,
            "subject_header": self.headers.get("X-OpenDDIL-Subject", ""),
        })
        out = state["body"]
        self.send_response(state["status"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_factory():
    topaz = _serve(FakeTopaz)
    exercise = _serve(FakeExerciseControl)

    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:1"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ["OPENDDIL_EXERCISE_CONTROL_URL"] = f"http://127.0.0.1:{exercise.server_port}"
    os.environ.pop("OPENDDIL_EXERCISE_CONTROL_ROLES", None)  # default: supervisor
    os.environ.pop("OPENDDIL_WAN_CONTROL_URL", None)
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"

    servers = []

    def start():
        srv = _serve(pep.Pep)
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_port}"

    yield start
    for s in servers + [topaz, exercise]:
        s.shutdown()
    for var in ("OPENDDIL_EXERCISE_CONTROL_URL", "OPENDDIL_EXERCISE_CONTROL_ROLES"):
        os.environ.pop(var, None)


def _get(url: str, subject: str | None):
    req = urllib.request.Request(url)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post(url: str, subject: str | None, body: bytes | None = b""):
    req = urllib.request.Request(url, data=body or b"", method="POST")
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@pytest.fixture
def pep_url(pep_factory):
    state.update(calls=[], status=200)
    return pep_factory()


# --- unauthenticated -> 401, zero calls -------------------------------------

def test_no_session_get_status_is_401(pep_url):
    code, _ = _get(pep_url + "/exercise/status", None)
    assert code == 401
    assert state["calls"] == []


def test_no_session_post_op_is_401(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", None)
    assert code == 401
    assert state["calls"] == []


# --- a non-exercise-control role is refused, nothing reaches the service ---

def test_operator_role_post_is_403_and_logged_through_deny(pep_url, caplog):
    with caplog.at_level("WARNING"):
        code, _ = _post(pep_url + "/exercise/op/pause", "operator.1")
    assert code == 403
    assert state["calls"] == []
    assert any("TOPAZ AUTHZ DENIED" in r.getMessage() for r in caplog.records)


def test_operator_role_get_is_403(pep_url):
    code, _ = _get(pep_url + "/exercise/status", "operator.1")
    assert code == 403
    assert state["calls"] == []


def test_unknown_subject_is_403(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", "stranger")
    assert code == 403
    assert state["calls"] == []


def test_topaz_down_is_503_zero_calls(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", "pdp-down")
    assert code == 503
    assert state["calls"] == []


# --- supervisor is admitted and forwarded -----------------------------------

def test_supervisor_get_status_forwards(pep_url):
    code, body = _get(pep_url + "/exercise/status", "supervisor.1")
    assert code == 200
    assert json.loads(body)["adapter"]["name"] == "x"
    assert len(state["calls"]) == 1
    assert state["calls"][0]["method"] == "GET"
    assert state["calls"][0]["path"] == "/exercise/status"


def test_supervisor_post_op_forwards_exactly_one_call(pep_url, caplog):
    state["status"] = 200
    with caplog.at_level("INFO"):
        code, _ = _post(pep_url + "/exercise/op/pause", "supervisor.1")
    assert code == 200
    assert len(state["calls"]) == 1
    assert state["calls"][0]["method"] == "POST"
    assert state["calls"][0]["path"] == "/exercise/op/pause"
    assert any("EXERCISE CONTROL" in r.getMessage() for r in caplog.records)


# --- subject header is ALWAYS the session's own, never the client's --------
#
# Header mode (used everywhere else in this file) can't exercise this: the
# "session subject" in header mode literally IS the incoming header, so
# there is nothing to overwrite. This one test runs the PEP in OIDC mode
# instead, with a real server-side session, and sends a DIFFERENT,
# forged X-OpenDDIL-Subject on the request -- proving the forged header is
# discarded and the session's own subject (bound server-side, not sent by
# the client at all) is what reaches the fake service.

def test_client_sent_subject_header_is_overwritten_by_session_subject(pep_factory, monkeypatch):
    import oidc  # noqa: PLC0415
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "AUTH_MODE", "oidc")
    sid, _session = oidc.create_session({"sub": "supervisor.1"})
    url = pep_factory()
    state.update(calls=[], status=200)

    req = urllib.request.Request(url + "/exercise/op/pause", data=b"", method="POST")
    req.add_header("Cookie", f"{oidc.COOKIE_NAME}={sid}")
    req.add_header("X-OpenDDIL-Subject", "evil.subject")  # must be ignored
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.status == 200
    assert len(state["calls"]) == 1
    assert state["calls"][0]["subject_header"] == "supervisor.1"


# --- URL unset -> 404 --------------------------------------------------------

def test_exercise_control_url_unset_is_404(pep_factory, monkeypatch):
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "EXERCISE_CONTROL_URL", "")
    url = pep_factory()
    code, _ = _get(url + "/exercise/status", "supervisor.1")
    assert code == 404


# --- anything else under /exercise/ -> 404, zero calls ----------------------

def test_exercise_other_is_404(pep_url):
    code, _ = _get(pep_url + "/exercise/other", "supervisor.1")
    assert code == 404
    assert state["calls"] == []


def test_exercise_op_sub_path_is_404(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause/extra", "supervisor.1")
    assert code == 404
    assert state["calls"] == []


def test_exercise_op_not_a_plain_word_is_404(pep_url):
    for op in ("..%2Fhealthz", "pause%2Fx", "Pause", "p%61use"):
        code, _ = _post(pep_url + "/exercise/op/" + op, "supervisor.1")
        assert (op, code) == (op, 404)
    assert state["calls"] == []


def test_exercise_op_with_no_op_is_404(pep_url):
    code, _ = _post(pep_url + "/exercise/op/", "supervisor.1")
    assert code == 404
    assert state["calls"] == []


def test_get_on_op_path_is_404(pep_url):
    code, _ = _get(pep_url + "/exercise/op/pause", "supervisor.1")
    assert code == 404
    assert state["calls"] == []


# --- the role guard, flipped once, output recorded --------------------------
#
# Flipping EXERCISE_CONTROL_ROLES to a role the fake PDP never returns
# ("auditor" -- SUBJECT_ROLES only ever answers edge-operator/supervisor)
# makes the previously-admitted supervisor subject refused too: proof the
# check is live, not a tautology that always passes.
def test_role_guard_flip_supervisor_now_refused(pep_factory, monkeypatch):
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "EXERCISE_CONTROL_ROLES", frozenset({"auditor"}))
    url = pep_factory()
    state.update(calls=[], status=200)
    code, body = _post(url + "/exercise/op/pause", "supervisor.1")
    assert code == 403, f"role guard flip did not refuse: got {code} {body!r}"
    assert state["calls"] == []
