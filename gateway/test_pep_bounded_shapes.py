"""The bounded reads' shapes (_follow_shape) are tracked like the proxy's.

Drives the real `_follow_shape` against a stub Electric with a fake clock in
place of pep._now. Metrics are read over HTTP from the real metrics server.

Run:  py -3 -m pytest gateway/test_pep_bounded_shapes.py
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

TABLE = "asset_element_state"
COLS = ["asset_id", "element_path"]
WHERE = "asset_id = 'a1' AND depth <= 1"
PERIOD = 3600
CEILING = 5400
IDLE = 1800

UP = {"headers": {"control": "up-to-date"}}
MUST = {"headers": {"control": "must-refetch"}}
ROW = {"key": "k1", "value": {"asset_id": "a1"}, "headers": {"operation": "insert"}}

GETS: list[dict] = []
DELETES: list[str] = []
SCRIPT: list[tuple[int, str | None, list]] = []   # overrides the default answer


class FakeElectric(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, status, handle=None, body=b"[]"):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        if handle:
            self.send_header("electric-handle", handle)
            self.send_header("electric-offset", "0_0")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        GETS.append({k: v[0] for k, v in params.items()})
        if SCRIPT:
            status, handle, msgs = SCRIPT.pop(0)
            self._reply(status, handle, json.dumps(msgs).encode())
            return
        key = "|".join((params.get(k) or [""])[0] for k in ("table", "where", "columns"))
        handle = "electric-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        self._reply(200, handle, json.dumps([ROW, UP]).encode())

    def do_DELETE(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        DELETES.extend(params.get("handle") or [])
        self._reply(202)


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_module():
    electric = _serve(FakeElectric)
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://topaz.invalid:9")
    os.environ["OPENDDIL_PEP_SHAPE_CEILING_S"] = str(CEILING)
    os.environ["OPENDDIL_PEP_SHAPE_ROTATE_S"] = str(PERIOD)
    os.environ["OPENDDIL_PEP_SHAPE_IDLE_S"] = str(IDLE)
    for k in ("OPENDDIL_SESSION_TTL_SECONDS", "OPENDDIL_SESSION_MAX_SECONDS",
              "OPENDDIL_SESSION_MODE", "OPENDDIL_OIDC_ISSUER"):
        os.environ.pop(k, None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.PEP_TIER = "edge-test"
    metrics = pep.start_metrics_server(0)
    yield pep, f"http://127.0.0.1:{metrics.server_port}"
    metrics.shutdown()
    electric.shutdown()
    for k in ("OPENDDIL_PEP_SHAPE_IDLE_S", "OPENDDIL_PEP_SHAPE_ROTATE_S",
              "OPENDDIL_PEP_SHAPE_CEILING_S"):
        os.environ.pop(k, None)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(autouse=True)
def clock(pep_module):
    pep, _m = pep_module
    saved = (pep._now, pep.SHAPE_ROTATE_S, pep.SHAPE_IDLE_S)
    c = Clock()
    pep._now = c

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
        GETS.clear()
        DELETES.clear()
        SCRIPT.clear()

    wipe()
    yield c
    wipe()
    pep._now, pep.SHAPE_ROTATE_S, pep.SHAPE_IDLE_S = saved


def _read(pep):
    return pep._follow_shape(TABLE, WHERE, COLS, "k")


def _series(murl: str) -> dict[tuple[str, tuple], float]:
    """Parse the real exposition: (name, sorted label items) -> value."""
    with urllib.request.urlopen(f"{murl}/metrics", timeout=10) as r:
        text = r.read().decode()
    out = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = re.fullmatch(r"([a-z_0-9]+)(?:\{(.*)\})? (\S+)", line)
        assert m, line
        labels = tuple(sorted(re.findall(r'(\w+)="([^"]*)"', m.group(2) or "")))
        out[(m.group(1), labels)] = float(m.group(3))
    return out


def _g(series, name, **labels):
    key = (name, tuple(sorted({"tier": "edge-test", **labels}.items())))
    return series.get(key)


def _msgs(caplog, text):
    return [r.getMessage() for r in caplog.records if text in r.getMessage()]


def test_bound_logged_once_and_gauges(pep_module, clock, caplog):
    pep, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    pep.note_handle_born(TABLE, "proxy-h")          # a proxy handle, for contrast
    before = _series(murl)
    assert _g(before, "openddil_pep_shape_handles", table=TABLE) == 1
    assert _read(pep) == [{"asset_id": "a1"}]
    h = next(iter(h for h in pep._handle_born if h != "proxy-h"))
    assert len(_msgs(caplog, f"SHAPE HANDLE BOUND table={TABLE} handle={h} source=bounded")) == 1
    assert _read(pep) == [{"asset_id": "a1"}]
    assert len(_msgs(caplog, f"handle={h}")) == 1   # no second BOUND
    after = _series(murl)
    assert _g(after, "openddil_pep_bounded_shape_handles", table=TABLE) == 1
    assert _g(after, "openddil_pep_bounded_shape_handle_age_seconds", table=TABLE) == 0
    assert _g(after, "openddil_pep_shape_handles", table=TABLE) == 1
    assert (_g(after, "openddil_pep_shape_handle_age_seconds", table=TABLE)
            == _g(before, "openddil_pep_shape_handle_age_seconds", table=TABLE))
    assert not [r for r in caplog.records if "/v1/shape?" in r.getMessage()]


def test_rotation_after_the_rows(pep_module, clock, caplog):
    pep, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    _read(pep)
    h = next(iter(pep._handle_born))
    clock.t += PERIOD + 1
    assert _read(pep) == [{"asset_id": "a1"}]
    assert DELETES == [h]
    rot = _msgs(caplog, "SHAPE ROTATED")
    assert len(rot) == 1 and rot[0].endswith("outcome=deleted source=bounded")
    assert h not in pep._handle_born and h not in pep._rotated
    assert _g(_series(murl), "openddil_pep_shape_rotations_total", outcome="deleted") == 1
    assert _g(_series(murl), "openddil_pep_bounded_shape_handles", table=TABLE) is None


def test_no_rotation_below_the_period(pep_module, clock):
    pep, _m = pep_module
    _read(pep)
    clock.t += PERIOD - 1
    _read(pep)
    assert DELETES == []


def test_idle_sweep_deletes_a_bounded_handle(pep_module, clock, caplog):
    pep, murl = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    _read(pep)
    h = next(iter(pep._handle_born))
    clock.t += IDLE + 1
    assert pep.shape_idle_sweep() == 1
    assert DELETES == [h]
    hits = _msgs(caplog, "SHAPE IDLE DELETED")
    assert len(hits) == 1 and hits[0].endswith("outcome=deleted source=bounded")
    assert h not in pep._handle_born
    assert _g(_series(murl), "openddil_pep_shape_idle_deletes_total", outcome="deleted") == 1


def test_proxy_lines_unchanged(pep_module, clock, caplog):
    pep, _m = pep_module
    caplog.set_level(logging.INFO, logger="pep")
    pep.note_handle_born(TABLE, "ph")
    clock.t += IDLE + 1
    pep.shape_idle_sweep()
    assert _msgs(caplog, "SHAPE HANDLE BOUND")[0] == f"SHAPE HANDLE BOUND table={TABLE} handle=ph"
    assert not any("source=" in m for m in _msgs(caplog, "SHAPE IDLE DELETED"))


def test_first_source_wins(pep_module, clock):
    pep, _m = pep_module
    pep.note_handle_born(TABLE, "h", source="proxy")
    new, rotate, _age = pep.note_handle_born(TABLE, "h", source="bounded")
    assert (new, rotate) == (False, False)
    assert pep._handle_born["h"][3] == "proxy"
    clock.t += PERIOD + 1
    assert pep.note_handle_born(TABLE, "h", source="bounded")[1] is False


def test_409_tracks_the_new_handle(pep_module, clock):
    pep, _m = pep_module
    SCRIPT[:] = [(200, "h1", [ROW]),
                 (409, "h-gone", [MUST]),
                 (200, "h2", [ROW, UP])]
    assert _read(pep) == [{"asset_id": "a1"}]
    assert GETS[1].get("handle") == "h1" and GETS[2].get("offset") == "-1"
    assert "handle" not in GETS[2]
    assert pep._handle_born["h2"][3] == "bounded"


def test_must_refetch_tracks_the_new_handle(pep_module, clock):
    pep, _m = pep_module
    SCRIPT[:] = [(200, "h1", [MUST]), (200, "h2", [ROW, UP])]
    assert _read(pep) == [{"asset_id": "a1"}]
    assert "h2" in pep._handle_born and pep._handle_born["h2"][3] == "bounded"
    assert "h1" not in pep._handle_born


def test_rotation_flagged_on_an_early_response_survives(pep_module, clock):
    pep, _m = pep_module
    pep.note_handle_born(TABLE, "h1", source="bounded")
    clock.t += PERIOD + 1
    SCRIPT[:] = [(200, "h1", [ROW]), (200, "h1", [UP])]
    assert _read(pep) == [{"asset_id": "a1"}]
    assert DELETES == ["h1"] and "h1" not in pep._handle_born


def test_metrics_series_present_from_start(pep_module, clock):
    _pep, murl = pep_module
    text = urllib.request.urlopen(f"{murl}/metrics", timeout=10).read().decode()
    assert "# TYPE openddil_pep_bounded_shape_handles gauge" in text
    assert "# TYPE openddil_pep_bounded_shape_handle_age_seconds gauge" in text
