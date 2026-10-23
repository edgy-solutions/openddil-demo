"""A 409 must-refetch from Electric reaches the browser, new handle bound.

A quick reset restarts Electric. An open page then resumes with its old
shape handle and Electric answers 409 (new handle in `electric-handle`,
must-refetch body). The Electric client handles that by resetting to the
header's handle and refetching from scratch. If the PEP turns the 409 into a
bare 502 the client retries the dead handle forever.

Drives the REAL PEP handler against a stub Topaz and a stub Electric, the way
test_pep_handle_binding.py does.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ENTITLEMENTS = {"op.a": ["ATL"], "op.b": ["ATL"]}
RESTARTED = False   # Electric has been "restarted": h-old is dead
NO_HANDLE = False   # the 409 carries no electric-handle header

UP_TO_DATE = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
MUST_REFETCH = json.dumps([{"headers": {"control": "must-refetch"}}]).encode()


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        nations = ENTITLEMENTS.get(subject, [])
        x = {"allow": bool(nations), "allowed_nations": nations,
             "subject_known": subject in ENTITLEMENTS,
             "policy_version": "p1", "corpus_version": "c1", "role": "edge-operator"}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeElectric(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, handle=None):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        if handle:
            self.send_header("electric-handle", handle)
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        table = (params.get("table") or [""])[0]
        handle = (params.get("handle") or [""])[0]
        if table == "boom":
            self._send(500, b"")
        elif handle == "h-old" and RESTARTED:
            self._send(409, MUST_REFETCH, None if NO_HANDLE else "h-new")
        elif handle == "h-new":
            self._send(200, UP_TO_DATE, "h-new")
        else:
            self._send(200, UP_TO_DATE, "h-new" if RESTARTED else "h-old")


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_module():
    topaz = _serve(FakeTopaz)
    electric = _serve(FakeElectric)
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    pep_srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{pep_srv.server_port}"
    for s in (pep_srv, topaz, electric):
        s.shutdown()


@pytest.fixture(autouse=True)
def _reset(pep_module):
    global RESTARTED, NO_HANDLE
    RESTARTED = False
    NO_HANDLE = False
    pep_module[0]._feeds.clear()
    yield
    RESTARTED = False
    NO_HANDLE = False


def _get(url: str, subject: str, timeout: float = 10):
    req = urllib.request.Request(url)
    req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def _shape(base, subject, table="t", handle=None, timeout=10):
    url = f"{base}/v1/shape?table={table}&offset=-1"
    if handle:
        url += f"&handle={handle}"
    return _get(url, subject, timeout)


def _hdr(headers, name):
    return {k.lower(): v for k, v in headers.items()}.get(name)


def _open_then_restart(base, subject="op.a"):
    global RESTARTED
    status, headers, _ = _shape(base, subject)
    assert status == 200 and _hdr(headers, "electric-handle") == "h-old"
    RESTARTED = True


def test_a_409_reaches_the_client_with_the_new_handle(pep_module):
    _pep, base = pep_module
    _open_then_restart(base)
    status, headers, body = _shape(base, "op.a", handle="h-old")
    assert status == 409
    assert _hdr(headers, "electric-handle") == "h-new"
    msgs = json.loads(body)
    assert msgs[0]["headers"]["control"] == "must-refetch"


def test_b_the_new_handle_is_resumable_per_principal(pep_module):
    _pep, base = pep_module
    _open_then_restart(base)
    assert _shape(base, "op.a", handle="h-old")[0] == 409
    assert _shape(base, "op.a", handle="h-new")[0] == 200
    # same entitlements, never bound: still refused
    assert _shape(base, "op.b", handle="h-new")[0] == 403


def test_c_a_409_without_a_handle_header_still_passes(pep_module):
    global NO_HANDLE
    _pep, base = pep_module
    _open_then_restart(base)
    NO_HANDLE = True
    status, headers, body = _shape(base, "op.a", handle="h-old")
    assert status == 409
    assert _hdr(headers, "electric-handle") is None
    assert json.loads(body)[0]["headers"]["control"] == "must-refetch"
    assert _shape(base, "op.a")[0] == 200


def test_d_other_upstream_failures_stay_a_bare_502(pep_module):
    _pep, base = pep_module
    status, _h, body = _shape(base, "op.a", table="boom")
    assert status == 502
    assert body == b""


def test_e_repeated_409s_do_not_leak_slots(pep_module):
    pep_mod, base = pep_module
    _open_then_restart(base)
    for _ in range(20):
        status, _h, _b = _shape(base, "op.a", handle="h-old")
        if status == 403:  # h-old aged out of the binding window; re-bind
            pep_mod.bind_handle("op.a", ("t", "(nation IN ('ATL'))", ""), "h-old")
            status, _h, _b = _shape(base, "op.a", handle="h-old")
        assert status == 409
    t0 = time.monotonic()
    assert _shape(base, "op.a", timeout=5)[0] == 200
    assert time.monotonic() - t0 < 5


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
