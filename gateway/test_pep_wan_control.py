"""GET/POST /proxies/hq-link, run through the real PEP handler.

The WAN slider used to reach the DDIL sever mechanism's HTTP API directly,
with no session and no role check -- this checks that both methods now go
through the gateway's subject-then-Topaz sequence, that a role other than
the configured WAN-control role is refused with nothing forwarded, and that
an admitted request is forwarded verbatim (method, body, User-Agent) with
the upstream's own status and body relayed back.

pep.py reads its upstreams at import, so Topaz and the "toxiproxy" stand-in
are fakes on loopback started before the import, and the PEP runs in header
mode (no issuer set) -- same harness as test_pep_cm_write.py.

Run:  py -3 -m pytest gateway/test_pep_wan_control.py -q
"""
from __future__ import annotations

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

# Who the fake PDP knows, keyed by subject -> role. A subject absent from
# this dict is "not in the entitlements corpus" (subject_known=False),
# exactly like policy/users.yaml's own default-deny.
SUBJECT_ROLES = {
    "supervisor.1": "supervisor",
    "operator.1": "edge-operator",
}

state = {
    "wan_calls": [],
    "wan_status": 200,
    "wan_body": b'{"enabled": false}',
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


class FakeWanControl(BaseHTTPRequestHandler):
    """Stands in for the DDIL sever mechanism's HTTP API at /proxies/hq-link."""

    def log_message(self, *a):
        pass

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        state["wan_calls"].append({
            "method": method,
            "path": self.path,
            "body": body,
            "user_agent": self.headers.get("User-Agent", ""),
        })
        out = state["wan_body"]
        self.send_response(state["wan_status"])
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
    wan = _serve(FakeWanControl)

    # ELECTRIC is required at import but never reached by this route --
    # a placeholder that is never dialed.
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:1"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ["OPENDDIL_WAN_CONTROL_URL"] = f"http://127.0.0.1:{wan.server_port}"
    os.environ.pop("OPENDDIL_WAN_CONTROL_ROLES", None)  # default: supervisor
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
    for s in servers + [topaz, wan]:
        s.shutdown()
    for var in ("OPENDDIL_WAN_CONTROL_URL", "OPENDDIL_WAN_CONTROL_ROLES"):
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


def _post(url: str, subject: str | None, body: dict | bytes | None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data or b"", method="POST")
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@pytest.fixture
def pep_url(pep_factory):
    state.update(wan_calls=[], wan_status=200, wan_body=b'{"enabled": false}')
    return pep_factory()


GOOD_BODY = {"enabled": False}


# --- 1-2: no session -------------------------------------------------------

def test_no_session_get_is_401(pep_url):
    code, _ = _get(pep_url + "/proxies/hq-link", None)
    assert code == 401
    assert state["wan_calls"] == []


def test_no_session_post_is_401(pep_url):
    code, _ = _post(pep_url + "/proxies/hq-link", None, GOOD_BODY)
    assert code == 401
    assert state["wan_calls"] == []


# --- 3-4: a non-WAN-control role is refused ---------------------------------

def test_operator_role_post_is_403_and_logged_through_deny(pep_url, caplog):
    with caplog.at_level("WARNING"):
        code, _ = _post(pep_url + "/proxies/hq-link", "operator.1", GOOD_BODY)
    assert code == 403
    assert state["wan_calls"] == []
    assert any("TOPAZ AUTHZ DENIED" in r.getMessage() for r in caplog.records)


def test_operator_role_get_is_403(pep_url):
    code, _ = _get(pep_url + "/proxies/hq-link", "operator.1")
    assert code == 403
    assert state["wan_calls"] == []


# --- 5: unknown subject -----------------------------------------------------

def test_unknown_subject_is_403(pep_url):
    code, _ = _post(pep_url + "/proxies/hq-link", "stranger", GOOD_BODY)
    assert code == 403
    assert state["wan_calls"] == []


# --- 6-7: supervisor is admitted and forwarded ------------------------------

def test_supervisor_post_forwards_exactly_one_call(pep_url, caplog):
    state["wan_status"] = 207  # distinguishable from a hardcoded 200
    with caplog.at_level("INFO"):
        code, _ = _post(pep_url + "/proxies/hq-link", "supervisor.1", GOOD_BODY)
    assert code == 207  # the upstream's own status, relayed verbatim
    assert len(state["wan_calls"]) == 1
    call = state["wan_calls"][0]
    assert call["method"] == "POST"
    assert call["path"] == "/proxies/hq-link"
    assert json.loads(call["body"]) == {"enabled": False}
    assert call["user_agent"] == "openddil-pep"
    assert any("WAN CONTROL" in r.getMessage() for r in caplog.records)


def test_supervisor_get_passes_through_upstream_body(pep_url):
    state["wan_body"] = b'{"enabled": true}'
    code, body = _get(pep_url + "/proxies/hq-link", "supervisor.1")
    assert code == 200
    assert json.loads(body) == {"enabled": True}
    assert len(state["wan_calls"]) == 1
    assert state["wan_calls"][0]["method"] == "GET"


# --- 8: malformed bodies -----------------------------------------------------

def test_string_enabled_is_400(pep_url):
    code, _ = _post(pep_url + "/proxies/hq-link", "supervisor.1", {"enabled": "false"})
    assert code == 400
    assert state["wan_calls"] == []


def test_extra_key_is_400(pep_url):
    code, _ = _post(pep_url + "/proxies/hq-link", "supervisor.1",
                     {"enabled": False, "x": 1})
    assert code == 400
    assert state["wan_calls"] == []


# --- 9: anything else under /proxies/ is 404, pre-PDP -----------------------

def test_sub_path_is_404(pep_url):
    code, _ = _get(pep_url + "/proxies/hq-link/toxics", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_other_proxies_path_is_404(pep_url):
    code, _ = _get(pep_url + "/proxies/other", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


# --- 10: not configured at this tier ----------------------------------------

def test_wan_control_url_unset_is_404(pep_factory, monkeypatch):
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "WAN_CONTROL_URL", "")
    url = pep_factory()
    code, _ = _get(url + "/proxies/hq-link", "supervisor.1")
    assert code == 404


# --- 11: PDP unavailable ----------------------------------------------------

def test_topaz_down_is_503(pep_url):
    code, _ = _post(pep_url + "/proxies/hq-link", "pdp-down", GOOD_BODY)
    assert code == 503
    assert state["wan_calls"] == []


# --- 12: the roles-parsing helper, in isolation -----------------------------

def test_parse_roles_csv_helper(pep_url):
    import pep  # noqa: PLC0415
    assert pep._parse_roles_csv("supervisor, auditor") == frozenset(
        {"supervisor", "auditor"})


# --- 13: a transport failure, not a policy deny -----------------------------

def test_upstream_connection_failure_is_502(pep_factory, monkeypatch):
    import pep  # noqa: PLC0415
    # A loopback port nothing listens on -- urlopen raises URLError
    # (connection refused), not HTTPError.
    dead = _serve(FakeWanControl)
    port = dead.server_port
    dead.shutdown()
    monkeypatch.setattr(pep, "WAN_CONTROL_URL", f"http://127.0.0.1:{port}")
    url = pep_factory()
    code, _ = _post(url + "/proxies/hq-link", "supervisor.1", GOOD_BODY)
    assert code == 502
