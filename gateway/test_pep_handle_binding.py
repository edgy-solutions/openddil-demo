"""Shape handles are bound per (principal, view), not per handle alone.

A handle is Electric's id for a shape DEFINITION -- table + where + columns
-- not a grant to one session: Electric mints the SAME handle for two
requests that happen to carry the same table/where/columns. The old
`_handles: dict[handle -> principal]` store treated the handle itself as the
grant, so the second of two sessions to open an identical view (two people
with the same entitlements, or one person in two tabs) silently overwrote
the first session's binding -- the loser got a permanent 403 ("shape handle
was not minted for this session") on every resume, the FEED UNAVAILABLE
symptom this file is named for.

This drives the REAL PEP handler (not a reimplementation) against a stub
Topaz and a stub Electric, the way test_pep_live_slots.py does. The stub
Electric mints a handle that is a deterministic hash of (table, where,
columns), the way real Electric hands out the same handle for the same
shape definition.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import hashlib
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

# Mutable at runtime: a test case that exercises an entitlement change
# between bind and resume flips an entry here between the two requests.
ENTITLEMENTS = {"op.a": ["ATL"], "op.b": ["ATL"], "op.c": ["ATL"]}


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
    """Mints the handle real Electric would: deterministic in the shape
    DEFINITION alone (table, where, columns), blind to who is asking --
    which is exactly the property that makes the old per-handle store an
    authorization hole and the new per-(principal, view) store correct."""

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        table = (params.get("table") or [""])[0]
        where = (params.get("where") or [""])[0]
        columns = (params.get("columns") or [""])[0]
        digest = hashlib.sha256(f"{table}|{where}|{columns}".encode()).hexdigest()[:16]
        handle = f"electric-{digest}"
        messages = [{"headers": {"control": "up-to-date"}}]
        out = json.dumps(messages).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", handle)
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)


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
def _reset_entitlements():
    """Each test case gets the baseline entitlements map; a case that
    mutates it (the entitlement-change case) does not leak into the next."""
    ENTITLEMENTS["op.a"] = ["ATL"]
    ENTITLEMENTS["op.b"] = ["ATL"]
    ENTITLEMENTS["op.c"] = ["ATL"]
    yield


def _get(url: str, subject: str, timeout: float = 10):
    req = urllib.request.Request(url)
    req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def _shape(base: str, subject: str, table: str = "t", handle: str | None = None) -> tuple:
    url = f"{base}/v1/shape?table={table}&offset=-1"
    if handle:
        url += f"&handle={handle}"
    return _get(url, subject)


def test_two_sessions_on_the_same_view_each_resume_their_own_handle(pep_module):
    """Two principals with identical entitlements open the same view (same
    table, same composed `where` because their nations match) with no
    handle: both 200, and Electric mints them the SAME handle, because it
    is blind to who asked. A binds, B binds. Both must then be able to
    resume with that handle -- on the old per-handle store, B's bind
    overwrote A's and A's resume came back 403 forever."""
    _pep, base = pep_module

    status_a, _h, _b = _shape(base, "op.a")
    assert status_a == 200
    status_b, _h, _b = _shape(base, "op.b")
    assert status_b == 200

    status_a2, headers_a, _ = _shape(base, "op.a")
    handle = headers_a.get("electric-handle")
    assert handle, "stub Electric did not mint a handle"
    status_b2, headers_b, _ = _shape(base, "op.b")
    assert headers_b.get("electric-handle") == handle, (
        "test setup assumption violated: op.a and op.b should compose the "
        "same `where` and so get the same handle from the stub")
    assert status_a2 == 200 and status_b2 == 200

    resume_a = _shape(base, "op.a", handle=handle)
    assert resume_a[0] == 200, resume_a

    resume_b = _shape(base, "op.b", handle=handle)
    assert resume_b[0] == 200, resume_b


def test_a_principal_that_never_opened_the_view_is_refused(pep_module):
    status, headers, _ = _shape(base := pep_module[1], "op.a")
    assert status == 200
    handle = headers.get("electric-handle")

    status_c, _h, _b = _shape(base, "op.c", handle=handle)
    assert status_c == 403


def test_unknown_handle_is_refused(pep_module):
    _pep, base = pep_module
    status, _h, _b = _shape(base, "op.a", handle="never-minted")
    assert status == 403


def test_handle_bound_on_one_table_does_not_resume_another(pep_module):
    _pep, base = pep_module
    status, headers, _ = _shape(base, "op.a", table="x")
    assert status == 200
    handle = headers.get("electric-handle")

    status_other_table, _h, _b = _shape(base, "op.a", table="y", handle=handle)
    assert status_other_table == 403


def test_entitlement_change_invalidates_the_old_binding(pep_module):
    """op.a binds a handle under its ATL-scoped `where`, then its
    entitlements change (stub Topaz now returns a different nation list) --
    the composed `where` differs, so the view it resumes under is not the
    view it was bound under, and the resume is refused rather than served
    under stale scope."""
    _pep, base = pep_module

    status, headers, _ = _shape(base, "op.a")
    assert status == 200
    handle = headers.get("electric-handle")

    ENTITLEMENTS["op.a"] = ["PAC"]

    status_resume, _h, _b = _shape(base, "op.a", handle=handle)
    assert status_resume == 403


def test_bind_handle_keeps_only_the_newest_eight(pep_module):
    pep_mod, _base = pep_module
    principal = "unit-test-principal"
    view = ("some_table", "some_where", "")

    for i in range(9):
        pep_mod.bind_handle(principal, view, f"h{i}")

    assert pep_mod.handle_belongs_to(principal, view, "h0") is False
    for i in range(1, 9):
        assert pep_mod.handle_belongs_to(principal, view, f"h{i}") is True


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
