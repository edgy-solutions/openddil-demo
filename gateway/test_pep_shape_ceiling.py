"""Shape handle age and the declared ceiling in the PEP.

Drives the REAL PEP handler against a stub Topaz and a stub Electric, with a
fake clock in place of pep._now. Metric assertions read the PEP's own /metrics
listener. The ceiling is a check: nothing here expects a refusal or a DELETE.

Run:  py -3 -m pytest gateway/test_pep_shape_ceiling.py
"""
from __future__ import annotations

import hashlib
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
ENTITLEMENTS = {"op.a": ["ATL"], "op.b": ["ATL"]}
COLS = "asset_id,element_path,depth"
WHERE = "asset_id = 'a1' AND depth <= 1"
CEILING = 5400

ELECTRIC_GETS: list[str] = []


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

    def do_GET(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        key = "|".join((params.get(k) or [""])[0] for k in ("table", "where", "columns"))
        ELECTRIC_GETS.append(self.path)
        handle = "electric-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        out = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
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
    os.environ["OPENDDIL_PEP_SHAPE_CEILING_S"] = str(CEILING)
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
    saved = (pep._now, pep.LABELED_TABLES, pep.SHAPE_CEILING_S)
    c = Clock()
    pep._now = c
    pep.LABELED_TABLES = {TABLE}

    def wipe():
        with pep._born_lock:
            pep._handle_born.clear()
            pep._over_ceiling.clear()
            pep._over_logged.clear()
        ELECTRIC_GETS.clear()

    wipe()
    yield c
    wipe()
    pep._now, pep.LABELED_TABLES, pep.SHAPE_CEILING_S = saved


def _get(base: str, subject: str = "op.a", handle: str | None = None):
    q = [("table", TABLE), ("offset", "0" if handle else "-1"),
         ("where", WHERE), ("columns", COLS)]
    if handle:
        q.append(("handle", handle))
    req = urllib.request.Request(f"{base}/v1/shape?" + urllib.parse.urlencode(q))
    req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("electric-handle")
    except urllib.error.HTTPError as e:
        return e.code, None


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


def _k(name: str, table: str | None = TABLE) -> str:
    return (f'{name}{{tier="edge-test",table="{table}"}}' if table is not None
            else f'{name}{{tier="edge-test"}}')


def test_birth_on_first_response(pep_module):
    _pep, base, murl = pep_module
    status, handle = _get(base)
    assert status == 200 and handle
    m = _metrics(murl)
    assert m[_k("openddil_pep_shape_handles")] == 1
    assert m[_k("openddil_pep_shape_handle_age_seconds")] == 0


def test_age_grows_with_the_clock(pep_module, clock):
    pep, base, murl = pep_module
    _, handle = _get(base)
    born = pep._handle_born[handle][1]
    clock.t += 100
    assert _get(base, handle=handle)[0] == 200
    assert _metrics(murl)[_k("openddil_pep_shape_handle_age_seconds")] == 100
    assert pep._handle_born[handle][1] == born


def test_red_case_counts_and_logs_once(pep_module, clock, caplog):
    _pep, base, murl = pep_module
    _, handle = _get(base)
    clock.t += CEILING + 1
    caplog.set_level(logging.WARNING, logger="pep")
    n = len(ELECTRIC_GETS)
    assert _get(base, handle=handle)[0] == 200
    assert _get(base, handle=handle)[0] == 200
    assert len(ELECTRIC_GETS) == n + 2
    text = _text(murl)
    print(*[ln for ln in text.splitlines() if "shape" in ln], sep="\n")
    assert _metrics(murl)[_k("openddil_pep_shape_over_ceiling_total")] == 2
    hits = [r for r in caplog.records
            if f"SHAPE OVER CEILING table={TABLE} age_s=" in r.getMessage()]
    assert len(hits) == 1
    assert f"ceiling_s={CEILING}" in hits[0].getMessage()


def test_under_ceiling_no_count(pep_module, clock):
    _pep, base, murl = pep_module
    _, handle = _get(base)
    clock.t += CEILING - 1
    _get(base, handle=handle)
    m = _metrics(murl)
    assert m[_k("openddil_pep_shape_over_ceiling_total", "")] == 0
    assert _k("openddil_pep_shape_over_ceiling_total") not in m


def test_unknown_handle_enters_at_zero(pep_module, clock):
    pep, _base, murl = pep_module
    assert pep.shape_age_check("t1", "never-seen") == 0
    assert "never-seen" in pep._handle_born
    clock.t += 10
    assert pep.shape_age_check("t1", "never-seen") == 10
    assert _metrics(murl)[_k("openddil_pep_shape_handle_age_seconds", "t1")] == 10


def test_ceiling_off_counts_nothing(pep_module, clock, caplog):
    pep, base, murl = pep_module
    pep.SHAPE_CEILING_S = 0
    _, handle = _get(base)
    clock.t += CEILING + 100
    caplog.set_level(logging.WARNING, logger="pep")
    _get(base, handle=handle)
    m = _metrics(murl)
    assert m[_k("openddil_pep_shape_handle_age_seconds")] == CEILING + 100
    assert m[_k("openddil_pep_shape_ceiling_seconds", None)] == 0
    assert m[_k("openddil_pep_shape_over_ceiling_total", "")] == 0
    assert not [r for r in caplog.records if "SHAPE OVER CEILING" in r.getMessage()]


def test_pruning(pep_module, clock):
    pep, _base, murl = pep_module
    pep.note_handle_born("t1", "old")
    clock.t += max(3600, 2 * CEILING) + 1
    pep.note_handle_born("t1", "fresh")
    _metrics(murl)
    assert "old" not in pep._handle_born
    assert "fresh" in pep._handle_born


def test_shared_view_is_one_entry(pep_module):
    pep, base, murl = pep_module
    _, h1 = _get(base, "op.a")
    _, h2 = _get(base, "op.b")
    assert h1 == h2
    assert len(pep._handle_born) == 1
    assert _metrics(murl)[_k("openddil_pep_shape_handles")] == 1


def test_negative_env_refused():
    env = dict(os.environ, OPENDDIL_PEP_SHAPE_CEILING_S="-1")
    here = Path(__file__).resolve().parent
    r = subprocess.run([sys.executable, "-c", "import pep"], cwd=here, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0
    assert "OPENDDIL_PEP_SHAPE_CEILING_S" in r.stderr


def test_series_exists_from_start(pep_module):
    _pep, _base, murl = pep_module
    m = _metrics(murl)
    assert m[_k("openddil_pep_shape_over_ceiling_total", "")] == 0
    assert m[_k("openddil_pep_shape_ceiling_seconds", None)] == CEILING
