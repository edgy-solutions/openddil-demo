"""The PEP holds Electric's shared secret: it is appended to every upstream
/v1/shape request, never taken from the client, and never shown to a browser
or written to a log. /v1/health is passed through without it.

Drives the real handler against a stub Topaz and a stub Electric that records
the upstream request (method, path, query).

Run:  py -3 -m pytest gateway -q
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SECRET = "dummy-secret-value-0001"
SEEN: list[dict] = []
MODE = {"status": 200}


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        json.loads(body["input"])
        x = {"allow": True, "allowed_nations": ["ATL"], "subject_known": True,
             "policy_version": "p1", "corpus_version": "c1", "role": "edge-operator"}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeElectric(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _rec(self, method):
        u = urllib.parse.urlparse(self.path)
        SEEN.append({"method": method, "path": u.path,
                     "q": urllib.parse.parse_qs(u.query, keep_blank_values=True)})
        return u

    def do_GET(self):  # noqa: N802
        u = self._rec("GET")
        if u.path == "/v1/health":
            out = b'{"status":"active"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Other", "nope")
        elif MODE["status"] != 200:
            out = b'{"error":"upstream said no"}'
            self.send_response(MODE["status"])
        else:
            out = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
            self.send_response(200)
            self.send_header("electric-handle", "h-fixed")
            self.send_header("electric-offset", "0")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_DELETE(self):  # noqa: N802
        self._rec("DELETE")
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def env():
    topaz = _serve(FakeTopaz)
    electric = _serve(FakeElectric)
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    os.environ.pop("OPENDDIL_ELECTRIC_SECRET", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    pep_srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{pep_srv.server_port}", electric
    for s in (pep_srv, topaz, electric):
        s.shutdown()


@pytest.fixture(autouse=True)
def _reset(env):
    pep = env[0]
    SEEN.clear()
    MODE["status"] = 200
    pep.ELECTRIC_SECRET = ""
    yield
    pep.ELECTRIC_SECRET = ""


def _get(base, path, query="", headers=True):
    req = urllib.request.Request(f"{base}{path}" + (f"?{query}" if query else ""))
    if headers:
        req.add_header("X-OpenDDIL-Subject", "op.a")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def _shape(base, extra=""):
    q = urllib.parse.urlencode({"table": "telemetry_latest_state", "offset": "-1"})
    return _get(base, "/v1/shape", q + extra)


def _shape_reqs():
    return [s for s in SEEN if s["path"] == "/v1/shape"]


def test_unset_and_set_differ_only_by_the_secret(env):
    pep, base, _ = env
    assert _shape(base)[0] == 200
    old = _shape_reqs()[-1]["q"]
    assert "secret" not in old
    SEEN.clear()
    pep.ELECTRIC_SECRET = SECRET
    assert _shape(base)[0] == 200
    new = _shape_reqs()[-1]["q"]
    assert new.pop("secret") == [SECRET]
    assert new == old


@pytest.mark.parametrize("name", ["secret", "api_secret"])
@pytest.mark.parametrize("configured", [False, True])
def test_client_secret_is_never_forwarded(env, name, configured):
    pep, base, _ = env
    if configured:
        pep.ELECTRIC_SECRET = SECRET
    _shape(base, f"&{name}=attacker")
    assert _shape_reqs()
    for r in _shape_reqs():
        assert "api_secret" not in r["q"]
        assert r["q"].get("secret", []) == ([SECRET] if configured else [])
        assert "attacker" not in json.dumps(r["q"])


def test_screen_collect_carries_the_secret(env):
    pep, _, _ = env
    pep.ELECTRIC_SECRET = SECRET
    got = pep._screen_collect("/v1/shape", [("table", "t"), ("offset", "-1")],
                              "p", ("t", "w"))
    assert got[0] == "flush"
    assert _shape_reqs()[-1]["q"]["secret"] == [SECRET]
    SEEN.clear()
    pep.ELECTRIC_SECRET = ""
    pep._screen_collect("/v1/shape", [("table", "t"), ("offset", "-1")],
                        "p", ("t", "w"))
    assert "secret" not in _shape_reqs()[-1]["q"]


def test_follow_shape_carries_the_secret(env):
    pep, _, _ = env
    pep.ELECTRIC_SECRET = SECRET
    pep._follow_shape("asset_registry", "true", ["asset_id"], "")
    assert _shape_reqs() and all(r["q"]["secret"] == [SECRET] for r in _shape_reqs())
    SEEN.clear()
    pep.ELECTRIC_SECRET = ""
    pep._follow_shape("asset_registry", "true", ["asset_id"], "")
    assert all("secret" not in r["q"] for r in _shape_reqs())


@pytest.mark.parametrize("configured", [True, False])
def test_grace_expiry_delete_carries_the_secret(env, configured):
    pep, _, _ = env
    saved = pep.ELEMENT_DELETE_UPSTREAM
    pep.ELEMENT_DELETE_UPSTREAM = True
    pep.ELECTRIC_SECRET = SECRET if configured else ""
    view = ("telemetry_latest_state", "w-secret-test")
    with pep._el_lock:
        pep._el_views[view] = {"holders": {}, "grace": object(), "handle": "h-1"}
    try:
        pep._el_grace_expired(view)
    finally:
        pep.ELEMENT_DELETE_UPSTREAM = saved
    dels = [s for s in SEEN if s["method"] == "DELETE"]
    assert len(dels) == 1
    assert dels[0]["q"].get("secret", []) == ([SECRET] if configured else [])
    assert dels[0]["q"]["handle"] == ["h-1"]
    assert "table" not in dels[0]["q"]


@pytest.mark.parametrize("configured", [True, False])
def test_rotation_delete_carries_the_secret_and_logs_none(env, configured, caplog):
    pep, _, _ = env
    pep.ELECTRIC_SECRET = SECRET if configured else ""
    with caplog.at_level(logging.DEBUG):
        pep._rotate_handle("telemetry_latest_state", "h-rot", 3601.0)
    dels = [s for s in SEEN if s["method"] == "DELETE"]
    assert len(dels) == 1
    assert sorted(dels[0]["q"]) == (["handle", "secret"] if configured else ["handle"])
    assert dels[0]["q"]["handle"] == ["h-rot"]
    assert dels[0]["q"].get("secret", []) == ([SECRET] if configured else [])
    assert all(SECRET not in r.getMessage() and "/v1/shape?" not in r.getMessage()
               for r in caplog.records)


@pytest.mark.parametrize("status", [401, 500])
def test_the_secret_never_reaches_logs_body_or_headers(env, caplog, status):
    pep, base, _ = env
    pep.ELECTRIC_SECRET = SECRET
    MODE["status"] = status
    with caplog.at_level(logging.DEBUG):
        code, body, hdrs = _shape(base)
        with pytest.raises(Exception) as ei:
            pep._follow_shape("asset_registry", "true", None, "")
        assert SECRET not in str(ei.value)
        with pytest.raises(Exception) as ei2:
            pep._screen_collect("/v1/shape", [("table", "t")], "p", ("t", "w"))
        assert SECRET not in str(ei2.value)
    assert code in (401, 500, 502)
    assert SECRET not in body.decode(errors="replace")
    assert SECRET not in json.dumps(hdrs)
    assert SECRET not in caplog.text
    assert SECRET not in "".join(str(r.__dict__) for r in caplog.records)


def test_success_response_headers_do_not_carry_the_secret(env):
    pep, base, _ = env
    pep.ELECTRIC_SECRET = SECRET
    code, body, hdrs = _shape(base)
    assert code == 200
    assert SECRET not in body.decode() and SECRET not in json.dumps(hdrs)
    assert not {"location", "content-location"} & {k.lower() for k in hdrs}


@pytest.mark.parametrize("configured", [False, True])
def test_health_is_passed_through_without_session_or_secret(env, configured):
    pep, base, _ = env
    if configured:
        pep.ELECTRIC_SECRET = SECRET
    code, body, hdrs = _get(base, "/v1/health", "secret=attacker&x=1", headers=False)
    assert code == 200 and json.loads(body) == {"status": "active"}
    assert hdrs.get("Content-Type") == "application/json"
    assert "X-Other" not in hdrs
    assert SEEN[-1]["path"] == "/v1/health" and SEEN[-1]["q"] == {}


def test_health_upstream_down_is_502_and_unknown_paths_stay_404(env, caplog):
    pep, base, _ = env
    pep.ELECTRIC_SECRET = SECRET
    up = pep.ELECTRIC
    pep.ELECTRIC = "http://127.0.0.1:9"
    try:
        with caplog.at_level(logging.DEBUG):
            code, body, _h = _get(base, "/v1/health", headers=False)
    finally:
        pep.ELECTRIC = up
    assert code == 502 and SECRET not in body.decode()
    assert SECRET not in caplog.text
    assert _get(base, "/v1/nope")[0] == 404
