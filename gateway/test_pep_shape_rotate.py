"""Rotation of a shape past the declared period in the PEP.

Drives the REAL PEP handler against a stub Topaz and a stub Electric, with a
fake clock in place of pep._now. The stub answers a GET that presents a handle
it has deleted with 409 and a new handle, as Electric does.

Run:  py -3 -m pytest gateway/test_pep_shape_rotate.py
"""
from __future__ import annotations

import hashlib
import itertools
import json
import logging
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

TABLE = "asset_element_state"
ENTITLEMENTS = {"op.a": ["ATL"]}
COLS = "asset_id,element_path,depth"
WHERE = "asset_id = 'a1' AND depth <= 1"
PERIOD = 3600
CEILING = 5400

ELECTRIC_GETS: list[str] = []
DELETES: list[dict] = []
DELETED: set[str] = set()
STATE = {"status": 202}
_new = itertools.count(1)


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

    def _reply(self, status, handle=None, body=b"[]"):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        if handle:
            self.send_header("electric-handle", handle)
            self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        ELECTRIC_GETS.append(self.path)
        presented = (params.get("handle") or [""])[0]
        if presented in DELETED:
            self._reply(409, f"electric-new-{next(_new)}",
                        json.dumps([{"headers": {"control": "must-refetch"}}]).encode())
            return
        key = "|".join((params.get(k) or [""])[0] for k in ("table", "where", "columns"))
        handle = "electric-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        self._reply(200, handle,
                    json.dumps([{"headers": {"control": "up-to-date"}}]).encode())

    def do_DELETE(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        DELETES.append(params)
        status = STATE["status"]
        if 200 <= status < 300:
            DELETED.update(params.get("handle") or [])
        self._reply(status)


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
    os.environ["OPENDDIL_PEP_SHAPE_CEILING_S"] = str(CEILING)
    os.environ["OPENDDIL_PEP_SHAPE_ROTATE_S"] = str(PERIOD)
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    pep.PEP_TIER = "edge-test"
    pep_srv = _serve(pep.Pep)
    metrics = pep.start_metrics_server(0)
    yield (pep, f"http://127.0.0.1:{pep_srv.server_port}",
           f"http://127.0.0.1:{metrics.server_port}")
    for s in (pep_srv, metrics, topaz, electric):
        s.shutdown()


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(autouse=True)
def clock(pep_module):
    pep, _base, _m = pep_module
    saved = (pep._now, pep.LABELED_TABLES, pep.SHAPE_ROTATE_S)
    c = Clock()
    pep._now = c
    pep.LABELED_TABLES = {TABLE}

    def wipe():
        with pep._born_lock:
            pep._handle_born.clear()
            pep._over_ceiling.clear()
            pep._over_logged.clear()
            pep._rotated.clear()
            for k in pep._rotations:
                pep._rotations[k] = 0
        ELECTRIC_GETS.clear()
        DELETES.clear()
        DELETED.clear()
        STATE["status"] = 202

    wipe()
    yield c
    wipe()
    pep._now, pep.LABELED_TABLES, pep.SHAPE_ROTATE_S = saved


def _get(base: str, handle: str | None = None):
    q = [("table", TABLE), ("offset", "0" if handle else "-1"),
         ("where", WHERE), ("columns", COLS)]
    if handle:
        q.append(("handle", handle))
    req = urllib.request.Request(f"{base}/v1/shape?" + urllib.parse.urlencode(q))
    req.add_header("X-OpenDDIL-Subject", "op.a")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("electric-handle")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("electric-handle")


def _text(murl: str) -> str:
    with urllib.request.urlopen(f"{murl}/metrics", timeout=10) as r:
        return r.read().decode()


def _metrics(murl: str) -> dict:
    out = {}
    for line in _text(murl).splitlines():
        if line and not line.startswith("#"):
            name, value = line.rsplit(" ", 1)
            out[name] = float(value)
    return out


def _rot(outcome: str) -> str:
    return f'openddil_pep_shape_rotations_total{{tier="edge-test",outcome="{outcome}"}}'


def _no_url_in_logs(caplog) -> None:
    assert not [r for r in caplog.records if "/v1/shape?" in r.getMessage()]


def test_rotation_deletes_once_and_moves_the_client_on(pep_module, clock, caplog):
    pep, base, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    _, h = _get(base)
    clock.t += PERIOD + 1
    status, new = _get(base, handle=h)
    assert status == 409 and new and new != h
    assert DELETES == [{"handle": [h]}]
    assert pep._handle_born[new][1] == clock.t
    text = _text(murl)
    print(*[r.getMessage() for r in caplog.records if "SHAPE ROTATED" in r.getMessage()],
          sep="\n")
    print(*[ln for ln in text.splitlines() if "rotat" in ln], sep="\n")
    m = _metrics(murl)
    assert m[_rot("deleted")] == 1
    assert m['openddil_pep_shape_rotate_seconds{tier="edge-test"}'] == PERIOD
    for o in ("not_found", "refused", "upstream_error"):
        assert m[_rot(o)] == 0
    hits = [r for r in caplog.records if "SHAPE ROTATED" in r.getMessage()]
    assert len(hits) == 1 and hits[0].levelno == logging.INFO
    assert "outcome=deleted" in hits[0].getMessage()
    _no_url_in_logs(caplog)


def test_once_per_handle(pep_module, clock):
    _pep, base, _m = pep_module
    _, h = _get(base)
    clock.t += PERIOD + 1
    _get(base, handle=h)
    _get(base, handle=h)
    assert len(DELETES) == 1


def test_under_the_period_no_delete(pep_module, clock):
    _pep, base, _m = pep_module
    _, h = _get(base)
    clock.t += PERIOD - 1
    assert _get(base, handle=h)[0] == 200
    assert DELETES == []


@pytest.mark.parametrize("code,outcome,level", [
    (405, "refused", logging.WARNING),
    (404, "not_found", logging.INFO),
    (500, "upstream_error", logging.WARNING),
])
def test_outcomes_still_forward(pep_module, clock, caplog, code, outcome, level):
    _pep, base, murl = pep_module
    STATE["status"] = code
    caplog.set_level(logging.INFO, logger="pep")
    _, h = _get(base)
    clock.t += PERIOD + 1
    n = len(ELECTRIC_GETS)
    assert _get(base, handle=h)[0] == 200
    assert len(ELECTRIC_GETS) == n + 1
    assert _metrics(murl)[_rot(outcome)] == 1
    hits = [r for r in caplog.records if "SHAPE ROTATED" in r.getMessage()]
    assert len(hits) == 1 and hits[0].levelno == level
    assert f"outcome={outcome}" in hits[0].getMessage()
    _no_url_in_logs(caplog)


def test_red_case_refused_rotation_still_counts_over_ceiling(pep_module, clock):
    _pep, base, murl = pep_module
    STATE["status"] = 405
    _, h = _get(base)
    clock.t += CEILING + 1
    assert _get(base, handle=h)[0] == 200
    assert _get(base, handle=h)[0] == 200
    assert len(DELETES) == 1
    m = _metrics(murl)
    key = f'openddil_pep_shape_over_ceiling_total{{tier="edge-test",table="{TABLE}"}}'
    assert m[key] == 2
    assert m[_rot("refused")] == 1


def test_off_deletes_nothing(pep_module, clock):
    pep, base, _m = pep_module
    pep.SHAPE_ROTATE_S = 0
    _, h = _get(base)
    clock.t += CEILING + 100
    assert _get(base, handle=h)[0] == 200
    assert DELETES == []


@pytest.mark.parametrize("rotate,ceiling", [("-1", "5400"), ("3600", "0"), ("5400", "5400")])
def test_import_refusals(rotate, ceiling):
    env = dict(os.environ, OPENDDIL_PEP_SHAPE_ROTATE_S=rotate,
               OPENDDIL_PEP_SHAPE_CEILING_S=ceiling)
    here = Path(__file__).resolve().parent
    r = subprocess.run([sys.executable, "-c", "import pep"], cwd=here, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0
    assert "OPENDDIL_PEP_SHAPE_ROTATE_S" in r.stderr
    assert "OPENDDIL_PEP_SHAPE_CEILING_S" in r.stderr
