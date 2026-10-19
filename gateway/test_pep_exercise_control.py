"""GET /exercise/status and POST /exercise/op/<op>, run through the real
PEP handler.

This checks that both routes go through the gateway's subject-then-Topaz
sequence like /proxies/uplink (ADR-0029's WAN control route), that any
subject the PDP knows is forwarded regardless of role, and an unknown
subject is refused with ZERO requests reaching the fake
exercise/control.py stand-in, that a
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
import time
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


ORIGINAL_BODY = state["body"]


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
        if state.get("delay"):
            time.sleep(state["delay"])
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
    os.environ.pop("OPENDDIL_EXERCISE_CONTROL_URL", None)


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
    state.update(calls=[], status=200, delay=0.0)
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


# --- any known subject is forwarded, whatever its role ----------------------

def test_operator_role_post_is_forwarded(pep_url, caplog):
    state["status"] = 207  # distinguishable from a hardcoded 200
    with caplog.at_level("INFO"):
        code, _ = _post(pep_url + "/exercise/op/pause", "operator.1")
    assert code == 207  # the upstream's own status, relayed verbatim
    assert len(state["calls"]) == 1
    assert state["calls"][0]["method"] == "POST"
    assert state["calls"][0]["path"] == "/exercise/op/pause"
    msgs = [r.getMessage() for r in caplog.records if "EXERCISE CONTROL" in r.getMessage()]
    assert msgs and "operator.1" in msgs[0] and "op=pause" in msgs[0]
    assert "role=" not in msgs[0]


def test_operator_role_get_is_forwarded(pep_url):
    code, _ = _get(pep_url + "/exercise/status", "operator.1")
    assert code == 200
    assert len(state["calls"]) == 1
    assert state["calls"][0]["method"] == "GET"
    assert state["calls"][0]["path"] == "/exercise/status"


def test_unknown_subject_is_403(pep_url, caplog):
    with caplog.at_level("WARNING"):
        code, _ = _post(pep_url + "/exercise/op/pause", "stranger")
    assert code == 403
    assert state["calls"] == []
    assert any("TOPAZ AUTHZ DENIED" in r.getMessage() for r in caplog.records)


def test_unknown_subject_get_is_403(pep_url):
    code, _ = _get(pep_url + "/exercise/status", "stranger")
    assert code == 403
    assert state["calls"] == []


def test_topaz_down_is_503_zero_calls(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", "pdp-down")
    assert code == 503
    assert state["calls"] == []


# --- a known subject's call reaches the service -----------------------------------

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


# --- the reset is the one supervisor-only exercise action --------------------

RESET_REFUSAL = ("Restart exercise needs the supervisor login: it destroys "
                 "exercise state and takes about 13 minutes.")


def test_supervisor_reset_is_forwarded(pep_url):
    state["status"] = 202
    code, _ = _post(pep_url + "/exercise/op/reset", "supervisor.1")
    assert code == 202
    assert len(state["calls"]) == 1
    assert state["calls"][0]["path"] == "/exercise/op/reset"


def test_operator_reset_is_403_with_zero_upstream_calls(pep_url, caplog):
    with caplog.at_level("WARNING"):
        code, body = _post(pep_url + "/exercise/op/reset", "operator.1")
    assert code == 403
    doc = json.loads(body)
    assert doc["error"] == "forbidden"
    assert doc["reason"] == RESET_REFUSAL
    assert state["calls"] == []
    msgs = [r.getMessage() for r in caplog.records if "RESET REFUSED" in r.getMessage()]
    assert msgs and "operator.1" in msgs[0] and "role=edge-operator" in msgs[0]


def test_operator_pause_is_still_forwarded(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", "operator.1")
    assert code == 200
    assert len(state["calls"]) == 1


def test_status_reports_may_press_per_role(pep_url):
    state["body"] = json.dumps({"adapter": {"name": "x"}, "reset_job": {"state": "idle"}}).encode()
    try:
        _, body = _get(pep_url + "/exercise/status", "operator.1")
        assert json.loads(body)["reset_job"]["may_press"] is False
        assert json.loads(body)["reset_job"]["state"] == "idle"
        _, body = _get(pep_url + "/exercise/status", "supervisor.1")
        assert json.loads(body)["reset_job"]["may_press"] is True
    finally:
        state["body"] = ORIGINAL_BODY


def test_status_without_reset_job_is_byte_identical(pep_url):
    for raw in (ORIGINAL_BODY, b"not json {", b'["reset_job"]', b'{"reset_job": 3}'):
        state["body"] = raw
        try:
            _, body = _get(pep_url + "/exercise/status", "operator.1")
            assert body == raw
        finally:
            state["body"] = ORIGINAL_BODY


def test_reset_roles_override_admits_operator(pep_url, monkeypatch):
    import pep  # noqa: PLC0415
    # The env var is read once at import through this parser.
    monkeypatch.setattr(pep, "EXERCISE_RESET_ROLES",
                        pep._parse_roles_csv("edge-operator,supervisor"))
    code, _ = _post(pep_url + "/exercise/op/reset", "operator.1")
    assert code == 200
    assert len(state["calls"]) == 1


# --- a POSTed op outwaits the status read ------------------------------------

def test_slow_reset_is_relayed_not_502_but_slow_status_is_502(pep_url, monkeypatch):
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "EXERCISE_STATUS_TIMEOUT_S", 0.5)
    monkeypatch.setattr(pep, "EXERCISE_OP_TIMEOUT_S", 3.0)
    state.update(status=202, delay=1.0)
    code, _ = _post(pep_url + "/exercise/op/reset", "supervisor.1")
    assert code == 202
    code, body = _get(pep_url + "/exercise/status", "supervisor.1")
    assert code == 502 and b"upstream unavailable" in body


# --- fail-closed gate: sequences and unknown words need the supervisor -------

SEQ_REFUSAL_TAIL = ("needs the supervisor login: an exercise sequence changes the "
                    "exercise for every viewer.")


def test_operator_sequence_is_403_with_zero_upstream_calls(pep_url, caplog):
    with caplog.at_level("WARNING"):
        code, body = _post(pep_url + "/exercise/op/cutheal", "operator.1")
    assert code == 403
    doc = json.loads(body)
    assert doc == {"error": "forbidden", "reason": "cutheal " + SEQ_REFUSAL_TAIL}
    assert state["calls"] == []
    msgs = [r.getMessage() for r in caplog.records if "EXERCISE OP REFUSED" in r.getMessage()]
    assert msgs and "subject=operator.1" in msgs[0] and "role=edge-operator" in msgs[0]
    assert "op=cutheal" in msgs[0]


def test_supervisor_sequence_is_forwarded_with_subject_header(pep_url):
    state["status"] = 202
    code, _ = _post(pep_url + "/exercise/op/cutheal", "supervisor.1")
    assert code == 202
    assert len(state["calls"]) == 1
    assert state["calls"][0]["path"] == "/exercise/op/cutheal"
    assert state["calls"][0]["subject_header"] == "supervisor.1"


def test_unknown_word_from_non_supervisor_is_403_fail_closed(pep_url):
    code, body = _post(pep_url + "/exercise/op/whatever", "operator.1")
    assert code == 403
    assert json.loads(body)["reason"].startswith("whatever needs the supervisor login")
    assert state["calls"] == []


def test_the_five_open_ops_are_forwarded_for_a_non_supervisor(pep_url):
    for op in ("pause", "resume", "stop", "restart", "run"):
        state["calls"].clear()
        code, _ = _post(pep_url + "/exercise/op/" + op, "operator.1")
        assert code == 200, op
        assert [c["path"] for c in state["calls"]] == ["/exercise/op/" + op]


def test_status_adds_may_press_to_each_sequence_entry(pep_url):
    state["body"] = json.dumps({"sequences": [{"name": "a"}, "junk", {"name": "b"}],
                                "reset_job": {"state": "idle"}}).encode()
    try:
        _, body = _get(pep_url + "/exercise/status", "operator.1")
        doc = json.loads(body)
        assert doc["sequences"] == [{"name": "a", "may_press": False}, "junk",
                                    {"name": "b", "may_press": False}]
        assert doc["reset_job"]["may_press"] is False
        _, body = _get(pep_url + "/exercise/status", "supervisor.1")
        doc = json.loads(body)
        assert [s["may_press"] for s in doc["sequences"] if isinstance(s, dict)] == [True, True]
    finally:
        state["body"] = ORIGINAL_BODY


def test_status_without_sequences_or_reset_job_is_byte_identical(pep_url):
    for raw in (ORIGINAL_BODY, b'{"sequences": 3}', b'{"sequences": "x", "a": 1}'):
        state["body"] = raw
        try:
            _, body = _get(pep_url + "/exercise/status", "operator.1")
            assert body == raw
        finally:
            state["body"] = ORIGINAL_BODY


def test_status_with_reset_job_only_is_annotated_as_before(pep_url):
    state["body"] = b'{"reset_job": {"state": "idle"}}'
    try:
        _, body = _get(pep_url + "/exercise/status", "operator.1")
        assert json.loads(body) == {"reset_job": {"state": "idle", "may_press": False}}
    finally:
        state["body"] = ORIGINAL_BODY


# --- reset pre-flight and the reset's confirmation body ---------------------

PREFLIGHT_DOC = (b'{"limit": 300, "runtimes": [{"name": "rt-a", "open": 5, "error": null}], '
                 b'"over": [], "open_over": 0, "needs_confirmation": false, "unreadable": false}')


def test_preflight_non_supervisor_is_403_zero_calls(pep_url):
    code, body = _get(pep_url + "/exercise/reset/preflight", "operator.1")
    assert code == 403
    assert json.loads(body)["reason"] == RESET_REFUSAL
    assert state["calls"] == []


def test_preflight_unknown_subject_is_403_zero_calls(pep_url):
    code, _ = _get(pep_url + "/exercise/reset/preflight", "nobody.9")
    assert code == 403 and state["calls"] == []


def test_preflight_supervisor_is_forwarded_and_relayed(pep_url):
    state["body"] = PREFLIGHT_DOC
    try:
        code, body = _get(pep_url + "/exercise/reset/preflight", "supervisor.1")
    finally:
        state["body"] = ORIGINAL_BODY
    assert code == 200 and body == PREFLIGHT_DOC
    assert len(state["calls"]) == 1
    call = state["calls"][0]
    assert (call["method"], call["path"]) == ("GET", "/exercise/reset/preflight")
    assert call["subject_header"] == "supervisor.1"


def test_reset_body_is_forwarded_verbatim(pep_url):
    state["status"] = 202
    raw = b'{"confirm_cancel_open": true, "seen_open": 412}'
    code, _ = _post(pep_url + "/exercise/op/reset", "supervisor.1", raw)
    assert code == 202
    assert len(state["calls"]) == 1 and state["calls"][0]["body"] == raw


@pytest.mark.parametrize("raw", [
    b"[1]", b"not json",
    b'{"confirm_cancel_open": "yes"}',
    b'{"confirm_cancel_open": true, "seen_open": -3}',
    b'{"confirm_cancel_open": true, "seen_open": true}',
    b'{"confirm_cancel_open": true, "other": 1}',
    b'{"confirm_cancel_open": true, "seen_open": 1, "pad": "' + b"a" * 1100 + b'"}',
])
def test_reset_invalid_body_is_400_not_forwarded(pep_url, raw):
    code, _ = _post(pep_url + "/exercise/op/reset", "supervisor.1", raw)
    assert code == 400
    assert state["calls"] == []


def test_reset_body_from_non_supervisor_is_403_not_400(pep_url):
    code, _ = _post(pep_url + "/exercise/op/reset", "operator.1", b"not json")
    assert code == 403 and state["calls"] == []


def test_non_reset_op_still_forwards_no_body(pep_url):
    code, _ = _post(pep_url + "/exercise/op/pause", "supervisor.1",
                    b'{"confirm_cancel_open": true, "seen_open": 1}')
    assert code == 200
    assert len(state["calls"]) == 1 and state["calls"][0]["body"] == b""
