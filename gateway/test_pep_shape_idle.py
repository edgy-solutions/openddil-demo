"""The idle sweep of shapes nobody reads any more, in the PEP.

Drives the REAL PEP handler against a stub Topaz and a stub Electric, with a
fake clock in place of pep._now. The stub answers a GET that presents a handle
it has deleted with 409 and a new handle, as Electric does. The sweep is called
directly; nothing sleeps.

Run:  py -3 -m pytest gateway/test_pep_shape_idle.py
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
IDLE = 1800
EVERY = 60

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
    os.environ["OPENDDIL_PEP_SHAPE_IDLE_S"] = str(IDLE)
    for k in ("OPENDDIL_SESSION_TTL_SECONDS", "OPENDDIL_SESSION_MAX_SECONDS",
              "OPENDDIL_SESSION_MODE"):
        os.environ.pop(k, None)
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
    os.environ.pop("OPENDDIL_PEP_SHAPE_IDLE_S", None)  # later modules import pep too


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(autouse=True)
def clock(pep_module):
    pep, _base, _m = pep_module
    saved = (pep._now, pep.LABELED_TABLES, pep.SHAPE_ROTATE_S, pep.SHAPE_IDLE_S)
    c = Clock()
    pep._now = c
    pep.LABELED_TABLES = {TABLE}

    def wipe():
        with pep._born_lock:
            pep._handle_born.clear()
            pep._over_ceiling.clear()
            pep._over_logged.clear()
            pep._rotated.clear()
            pep._idle_warned.clear()
            for k in pep._rotations:
                pep._rotations[k] = 0
                pep._idle_deletes[k] = 0
        ELECTRIC_GETS.clear()
        DELETES.clear()
        DELETED.clear()
        STATE["status"] = 202

    wipe()
    yield c
    wipe()
    pep._now, pep.LABELED_TABLES, pep.SHAPE_ROTATE_S, pep.SHAPE_IDLE_S = saved


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


def _idle(outcome: str) -> str:
    return f'openddil_pep_shape_idle_deletes_total{{tier="edge-test",outcome="{outcome}"}}'


OVERDUE = 'openddil_pep_shape_idle_overdue{tier="edge-test"}'
IDLE_G = 'openddil_pep_shape_idle_seconds{tier="edge-test"}'
HANDLES = f'openddil_pep_shape_handles{{tier="edge-test",table="{TABLE}"}}'


def _idle_logs(caplog):
    return [r for r in caplog.records if "SHAPE IDLE DELETED" in r.getMessage()]


def _no_url_in_logs(caplog) -> None:
    assert not [r for r in caplog.records if "/v1/shape?" in r.getMessage()]


def test_deleted_once(pep_module, clock, caplog):
    pep, base, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    _, h = _get(base)
    assert _metrics(murl)[HANDLES] == 1
    clock.t += IDLE + 1
    assert pep.shape_idle_sweep() == 1
    assert DELETES == [{"handle": [h]}]
    m = _metrics(murl)
    assert m[_idle("deleted")] == 1
    assert HANDLES not in m
    assert h not in pep._handle_born
    hits = _idle_logs(caplog)
    assert len(hits) == 1 and hits[0].levelno == logging.INFO
    assert f"handle={h}" in hits[0].getMessage()
    assert "outcome=deleted" in hits[0].getMessage()
    _no_url_in_logs(caplog)
    assert pep.shape_idle_sweep() == 0
    assert len(DELETES) == 1


def test_a_read_keeps_it(pep_module, clock):
    pep, base, murl = pep_module
    _, h = _get(base)
    clock.t += 1700
    assert _get(base, handle=h)[0] == 200
    clock.t += 200
    assert pep.shape_idle_sweep() == 0
    assert DELETES == []
    assert _metrics(murl)[HANDLES] == 1


def test_red_case_idle_handle_not_deleted(pep_module, clock, caplog):
    pep, base, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    STATE["status"] = 500
    _, h = _get(base)
    clock.t += IDLE + 2 * EVERY + 1
    assert pep.shape_idle_sweep() == 1
    m = _metrics(murl)
    assert m[_idle("upstream_error")] == 1
    assert h in pep._handle_born
    assert m[OVERDUE] == 1
    assert pep.shape_idle_sweep() == 1
    assert len(DELETES) == 2
    warns = [r for r in _idle_logs(caplog) if r.levelno == logging.WARNING]
    assert len(warns) == 1
    STATE["status"] = 202
    assert pep.shape_idle_sweep() == 1
    m = _metrics(murl)
    assert m[_idle("deleted")] == 1
    assert m[OVERDUE] == 0
    assert h not in pep._handle_born
    _no_url_in_logs(caplog)


def test_refused_keeps_the_entry(pep_module, clock):
    pep, base, murl = pep_module
    STATE["status"] = 405
    _, h = _get(base)
    clock.t += IDLE + 2 * EVERY + 1
    assert pep.shape_idle_sweep() == 1
    m = _metrics(murl)
    assert m[_idle("refused")] == 1
    assert h in pep._handle_born
    assert m[OVERDUE] == 1


def test_not_found_drops_the_entry(pep_module, clock, caplog):
    pep, base, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    STATE["status"] = 404
    _, h = _get(base)
    clock.t += IDLE + 1
    assert pep.shape_idle_sweep() == 1
    assert _metrics(murl)[_idle("not_found")] == 1
    assert h not in pep._handle_born
    hits = _idle_logs(caplog)
    assert len(hits) == 1 and hits[0].levelno == logging.INFO


def test_rotated_then_idle_sends_no_second_delete(pep_module, clock):
    pep, base, murl = pep_module
    _, h = _get(base)
    clock.t += PERIOD + 1
    status, new = _get(base, handle=h)
    assert status == 409 and new != h
    assert DELETES == [{"handle": [h]}]
    clock.t += IDLE + 1
    pep.shape_idle_sweep()
    assert [d["handle"] for d in DELETES].count([h]) == 1
    assert h not in pep._handle_born and h not in pep._rotated
    assert _metrics(murl)[_rot("deleted")] == 1


def test_no_prune_while_idle_is_on(pep_module, clock):
    pep, base, murl = pep_module
    STATE["status"] = 500
    _, h = _get(base)
    clock.t += IDLE + 2 * EVERY + 1
    pep.shape_idle_sweep()
    _metrics(murl)
    clock.t += max(3600, 2 * CEILING) + 100
    m = _metrics(murl)
    assert h in pep._handle_born
    assert m[HANDLES] == 1 and m[OVERDUE] == 1


def test_off(pep_module, clock):
    pep, base, murl = pep_module
    pep.SHAPE_IDLE_S = 0
    _, h = _get(base)
    clock.t += 86400
    assert pep.shape_idle_sweep() == 0
    assert DELETES == []
    m = _metrics(murl)
    assert m[OVERDUE] == 0 and m[IDLE_G] == 0
    assert h not in pep._handle_born  # pruning as before


def _import(**env_over):
    env = dict(os.environ, OPENDDIL_PEP_SHAPE_ROTATE_S="0", OPENDDIL_PEP_SHAPE_CEILING_S="0")
    for k in ("OPENDDIL_SESSION_TTL_SECONDS", "OPENDDIL_SESSION_MAX_SECONDS",
              "OPENDDIL_SESSION_MODE", "OPENDDIL_PEP_SHAPE_IDLE_S"):
        env.pop(k, None)
    env.update(env_over)
    here = Path(__file__).resolve().parent
    return subprocess.run([sys.executable, "-c", "import pep"], cwd=here, env=env,
                          capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("idle", ["-1", "900"])
def test_import_refusals(idle):
    r = _import(OPENDDIL_PEP_SHAPE_IDLE_S=idle)
    assert r.returncode != 0
    assert "OPENDDIL_PEP_SHAPE_IDLE_S" in r.stderr


def test_import_accepts_above_the_session():
    r = _import(OPENDDIL_PEP_SHAPE_IDLE_S="1800")
    assert r.returncode == 0, r.stderr


def test_series_present_from_start(pep_module, clock):
    _pep, _base, murl = pep_module
    m = _metrics(murl)
    assert m[IDLE_G] == IDLE
    assert m[OVERDUE] == 0
    for o in ("deleted", "not_found", "refused", "upstream_error"):
        assert m[_idle(o)] == 0


def test_bound_is_logged_once_per_handle(pep_module, clock, caplog):
    _pep, base, _m = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    _, h = _get(base)
    assert _get(base, handle=h)[0] == 200
    assert _get(base, handle=h)[0] == 200
    hits = [r.getMessage() for r in caplog.records
            if "SHAPE HANDLE BOUND" in r.getMessage() and f"handle={h}" in r.getMessage()]
    assert len(hits) == 1
    assert f"table={TABLE}" in hits[0] and "secret" not in hits[0].lower()
    _no_url_in_logs(caplog)
