"""The handle state file: save, adopt at start, and one real restart.

In-process tests use fake clocks in place of pep._now and pep._wall and a stub
Electric. The restart test runs pep.py as a subprocess, twice, on one file.

Run:  py -3 -m pytest gateway/test_pep_handle_state.py
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

TABLE = "asset_element_state"
PERIOD = 3600
CEILING = 5400
IDLE = 1800
WHERE = "asset_id = 'a1' AND depth <= 1"
COLS = "asset_id,element_path,depth"
HERE = Path(__file__).resolve().parent

DELETES: list[str] = []
ENTITLEMENTS = {"op.a": ["ATL"]}


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
        handle = "electric-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        body = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("electric-handle", handle)
        self.send_header("electric-offset", "0_0")
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        DELETES.extend(params.get("handle") or [])
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def stubs():
    topaz, electric = _serve(FakeTopaz), _serve(FakeElectric)
    yield (f"http://127.0.0.1:{topaz.server_port}",
           f"http://127.0.0.1:{electric.server_port}")
    topaz.shutdown()
    electric.shutdown()


@pytest.fixture(scope="module")
def pep_module(stubs):
    topaz, electric = stubs
    os.environ["OPENDDIL_ELECTRIC_URL"] = electric
    os.environ["OPENDDIL_TOPAZ_URL"] = topaz
    os.environ["OPENDDIL_PEP_SHAPE_CEILING_S"] = str(CEILING)
    os.environ["OPENDDIL_PEP_SHAPE_ROTATE_S"] = str(PERIOD)
    os.environ["OPENDDIL_PEP_SHAPE_IDLE_S"] = str(IDLE)
    for k in ("OPENDDIL_SESSION_TTL_SECONDS", "OPENDDIL_SESSION_MAX_SECONDS",
              "OPENDDIL_SESSION_MODE", "OPENDDIL_OIDC_ISSUER",
              "OPENDDIL_PEP_HANDLE_STATE_FILE", "OPENDDIL_PEP_HANDLE_STATE_EVERY_S"):
        os.environ.pop(k, None)
    sys.path.insert(0, str(HERE))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.PEP_TIER = "edge-test"
    metrics = pep.start_metrics_server(0)
    yield pep, f"http://127.0.0.1:{metrics.server_port}"
    metrics.shutdown()
    for k in ("OPENDDIL_PEP_SHAPE_IDLE_S", "OPENDDIL_PEP_SHAPE_ROTATE_S",
              "OPENDDIL_PEP_SHAPE_CEILING_S"):
        os.environ.pop(k, None)


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def env(pep_module, tmp_path):
    pep, murl = pep_module
    saved = (pep._now, pep._wall, pep.HANDLE_STATE_FILE, pep._state_last_key)
    mono, wall = Clock(1000.0), Clock(1_800_000_000.0)
    pep._now, pep._wall = mono, wall
    pep.HANDLE_STATE_FILE = str(tmp_path / "handles.json")

    def wipe():
        with pep._born_lock:
            pep._handle_born.clear()
            pep._over_logged.clear()
            pep._rotated.clear()
            pep._adopted_pending.clear()
            pep._adopted_rotating.clear()
            pep._idle_warned.clear()
            for k in pep._rotations:
                pep._rotations[k] = 0
                pep._adopted_rotations[k] = 0
                pep._idle_deletes[k] = 0
            for k in pep._state_writes:
                pep._state_writes[k] = 0
            for k in pep._state_adopted:
                pep._state_adopted[k] = 0
            pep._state_warned.clear()
        pep._state_last_key = None
        DELETES.clear()

    wipe()
    yield pep, murl, mono, wall, tmp_path / "handles.json", wipe
    wipe()
    pep._now, pep._wall, pep.HANDLE_STATE_FILE, pep._state_last_key = saved


def _series(murl: str) -> dict:
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
    return series.get((name, tuple(sorted({"tier": "edge-test", **labels}.items()))))


def _msgs(caplog, text):
    return [r.getMessage() for r in caplog.records if text in r.getMessage()]


def _seed(pep, mono, wall):
    """h-proxy (age 70, idle 20), h-bounded (age 20, idle 20, rotated)."""
    pep.note_handle_born(TABLE, "h-proxy")
    mono.t += 50
    wall.t += 50
    pep.note_handle_born(TABLE, "h-bounded", source="bounded")
    pep._rotated.add("h-bounded")
    mono.t += 20
    wall.t += 20
    with pep._born_lock:
        pep._handle_born["h-proxy"][2] = mono.t - 20  # last read 20 s ago


def _bounce(pep, mono, wall, wipe, gap=100):
    """Save, lose the in-memory state, let the wall clock run, start 'fresh'."""
    assert pep.save_handle_state() == "ok"
    wipe()
    pep._state_last_key = None
    mono.t = 50_000.0      # a new process has a new monotonic origin
    wall.t += gap


def test_round_trip_keeps_born_sources_and_rotated(env, caplog):
    pep, _m, mono, wall, _f, wipe = env
    caplog.set_level(logging.INFO, logger="pep")
    _seed(pep, mono, wall)
    _bounce(pep, mono, wall, wipe, gap=100)
    caplog.clear()
    assert pep.adopt_handle_state() == 2
    now = pep._now()
    p, b = pep._handle_born["h-proxy"], pep._handle_born["h-bounded"]
    assert (p[0], p[3], b[0], b[3]) == (TABLE, "proxy", TABLE, "bounded")
    assert now - p[1] == 70 + 100 and now - b[1] == 20 + 100
    assert now - p[2] == 20 + 100
    assert pep._rotated == {"h-bounded"}
    per = _msgs(caplog, "SHAPE HANDLE ADOPTED")
    assert len(per) == 2
    assert any(f"handle=h-proxy source=proxy age_s=170 idle_s=120" in m for m in per)
    assert any(f"handle=h-bounded source=bounded age_s=120" in m for m in per)
    summary = _msgs(caplog, "SHAPE HANDLES ADOPTED")
    assert len(summary) == 1
    assert "count=2 proxy=1 bounded=1 rotated=1 file_age_s=100" in summary[0]


def test_unchanged_and_atomic(env):
    pep, _m, mono, wall, f, _w = env
    _seed(pep, mono, wall)
    assert pep.save_handle_state() == "ok"
    assert pep.save_handle_state() == "unchanged"
    assert not Path(str(f) + ".tmp").exists()
    doc = json.loads(f.read_bytes())
    assert doc["version"] == 1 and doc["tier"] == "edge-test"
    assert len(doc["electric_id"]) == 16 and "http" not in f.read_text()
    assert {h["handle"] for h in doc["handles"]} == {"h-proxy", "h-bounded"}
    assert set(doc["handles"][0]) == {"handle", "table", "source", "born_wall",
                                      "last_seen_wall", "rotated"}


def test_save_into_a_missing_directory_is_quiet(env, caplog, tmp_path):
    pep, murl, mono, wall, _f, _w = env
    caplog.set_level(logging.DEBUG, logger="pep")
    pep.HANDLE_STATE_FILE = str(tmp_path / "nope" / "handles.json")
    _seed(pep, mono, wall)
    assert pep.save_handle_state() == "error"
    assert pep.save_handle_state() == "error"
    warns = _msgs(caplog, "SHAPE HANDLE STATE WRITE FAILED")
    assert len(warns) == 1                      # once per error kind
    assert not [r for r in caplog.records if r.exc_info]
    s = _series(murl)
    assert _g(s, "openddil_pep_handle_state_writes_total", outcome="error") == 2
    assert _g(s, "openddil_pep_handle_state_writes_total", outcome="ok") == 0


def test_missing_file(env, caplog):
    pep, *_ = env
    caplog.set_level(logging.INFO, logger="pep")
    assert pep.adopt_handle_state() == 0
    assert _msgs(caplog, "SHAPE HANDLES ADOPTED count=0 reason=no_file")


def _doc(pep, **over):
    d = {"version": 1, "tier": "edge-test", "electric_id": pep._electric_id(),
         "written_at": 1, "handles": [
             {"handle": "x", "table": TABLE, "source": "proxy", "born_wall": 1,
              "last_seen_wall": 1, "rotated": False}]}
    d.update(over)
    return json.dumps(d).encode()


@pytest.mark.parametrize("reason,mk", [
    ("unreadable", lambda pep: b"{not json"),
    ("unreadable", lambda pep: b"[1, 2]"),
    ("version", lambda pep: _doc(pep, version=2)),
    ("tier_changed", lambda pep: _doc(pep, tier="other")),
    ("electric_changed", lambda pep: _doc(pep, electric_id="0" * 16)),
])
def test_refusals(env, caplog, reason, mk):
    pep, _m, _mono, _wall, f, _w = env
    caplog.set_level(logging.INFO, logger="pep")
    data = mk(pep)
    f.write_bytes(data)
    assert pep.adopt_handle_state() == 0
    warns = _msgs(caplog, "SHAPE HANDLES NOT ADOPTED")
    assert len(warns) == 1 and warns[0].endswith(f"reason={reason}")
    assert pep._handle_born == {}
    assert f.read_bytes() == data               # not rewritten until the first save


def test_adopted_proxy_handle_is_idle_deleted(env, caplog):
    pep, _m, mono, wall, _f, wipe = env
    caplog.set_level(logging.INFO, logger="pep")
    _seed(pep, mono, wall)
    _bounce(pep, mono, wall, wipe, gap=IDLE)     # idle 20 + 1800 > IDLE
    pep.adopt_handle_state()
    mono.t += 1
    wall.t += 1
    assert pep.shape_idle_sweep() == 1           # h-proxy; h-bounded is rotated
    assert DELETES == ["h-proxy"]
    assert "h-proxy" not in pep._handle_born


def test_adopted_rotated_handle_is_forgotten_without_a_delete(env):
    pep, _m, mono, wall, _f, wipe = env
    _seed(pep, mono, wall)
    _bounce(pep, mono, wall, wipe, gap=IDLE)
    pep.adopt_handle_state()
    pep.shape_idle_sweep()
    assert "h-bounded" not in pep._handle_born and "h-bounded" not in pep._rotated
    assert "h-bounded" not in DELETES


def test_adopted_handle_presented_again_reports_true_age_and_rotates_on_first_read(env):
    pep, _m, mono, wall, _f, wipe = env
    pep.note_handle_born(TABLE, "young")
    pep.note_handle_born(TABLE, "old")
    mono.t += PERIOD + 500
    wall.t += PERIOD + 500
    with pep._born_lock:
        pep._handle_born["young"][1] = mono.t - 100     # born 100 s ago
    _bounce(pep, mono, wall, wipe, gap=50)
    pep.adopt_handle_state()
    assert abs(pep.shape_age_check(TABLE, "young") - 150) < 1
    assert DELETES == ["young"]                            # rotated on first read
    age = pep.shape_age_check(TABLE, "old")
    assert PERIOD + 500 + 50 - 1 <= age <= PERIOD + 500 + 50 + 1
    assert DELETES == ["young", "old"]
    assert pep.shape_age_check(TABLE, "old") > PERIOD
    assert DELETES == ["young", "old"]                     # once each


def test_metrics_over_http(env):
    pep, murl, mono, wall, _f, wipe = env
    s = _series(murl)
    for src in ("proxy", "bounded"):
        assert _g(s, "openddil_pep_shape_handles_adopted", source=src) == 0
    for o in ("ok", "unchanged", "error"):
        assert _g(s, "openddil_pep_handle_state_writes_total", outcome=o) == 0
    _seed(pep, mono, wall)
    _bounce(pep, mono, wall, wipe)
    pep.adopt_handle_state()
    assert pep.save_handle_state() in ("ok", "unchanged")
    s = _series(murl)
    assert _g(s, "openddil_pep_shape_handles_adopted", source="proxy") == 1
    assert _g(s, "openddil_pep_shape_handles_adopted", source="bounded") == 1
    assert _g(s, "openddil_pep_handle_state_writes_total", outcome="ok") >= 1


def test_every_s_below_one_refuses_at_import():
    e = dict(os.environ, OPENDDIL_PEP_HANDLE_STATE_EVERY_S="0.5",
             OPENDDIL_ELECTRIC_URL="http://127.0.0.1:9", OPENDDIL_TOPAZ_URL="http://127.0.0.1:9",
             OPENDDIL_PEP_SHAPE_ROTATE_S="0", OPENDDIL_PEP_SHAPE_CEILING_S="0",
             OPENDDIL_PEP_SHAPE_IDLE_S="0")
    r = subprocess.run([sys.executable, "-c", "import pep"], cwd=HERE, env=e,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "OPENDDIL_PEP_HANDLE_STATE_EVERY_S" in r.stderr


# --- one real restart ---------------------------------------------------------

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Proc:
    def __init__(self, env: dict) -> None:
        self.p = subprocess.Popen([sys.executable, "-u", "pep.py"], cwd=HERE, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True)
        self.lines: list[str] = []
        self._t = threading.Thread(target=self._pump, daemon=True)
        self._t.start()

    def _pump(self) -> None:
        for line in self.p.stdout:
            self.lines.append(line.rstrip("\n"))

    def wait_for(self, pred, timeout: float) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if any(pred(x) for x in list(self.lines)):
                return True
            if self.p.poll() is not None:
                break
            time.sleep(0.1)
        return any(pred(x) for x in list(self.lines))

    def stop(self) -> None:
        if self.p.poll() is None:
            self.p.kill()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        self._t.join(timeout=5)
        self.p.stdout.close()


def test_one_real_restart(stubs, tmp_path):
    topaz, electric = stubs
    state = tmp_path / "handles.json"
    port = _free_port()
    env = dict(os.environ,
               OPENDDIL_ELECTRIC_URL=electric, OPENDDIL_TOPAZ_URL=topaz,
               OPENDDIL_PEP_PORT=str(port), OPENDDIL_PEP_METRICS_PORT=str(_free_port()),
               OPENDDIL_LABELED_TABLES=TABLE, OPENDDIL_PEP_TIER="edge-restart",
               OPENDDIL_PEP_HANDLE_STATE_FILE=str(state),
               OPENDDIL_PEP_HANDLE_STATE_EVERY_S="1",
               OPENDDIL_PEP_SHAPE_ROTATE_S="0", OPENDDIL_PEP_SHAPE_CEILING_S="0",
               OPENDDIL_PEP_SHAPE_IDLE_S="0")
    for k in ("OPENDDIL_OIDC_ISSUER", "OPENDDIL_SESSION_MODE"):
        env.pop(k, None)
    first = second = None
    try:
        first = Proc(env)
        assert first.wait_for(lambda x: "read-path PEP listening" in x, 30), first.lines
        assert first.wait_for(lambda x: "handle state:" in x and "every 1s" in x, 10)
        q = urllib.parse.urlencode([("table", TABLE), ("offset", "-1"),
                                    ("where", WHERE), ("columns", COLS)])
        for _ in range(50):                    # the listener may trail the log line
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/shape?{q}")
                req.add_header("X-OpenDDIL-Subject", "op.a")
                with urllib.request.urlopen(req, timeout=10) as r:
                    handle = r.headers["electric-handle"]
                break
            except OSError:
                time.sleep(0.2)
        else:
            pytest.fail("the first process never answered")
        end = time.monotonic() + 10
        held = False
        while time.monotonic() < end and not held:
            try:
                held = handle in [h["handle"] for h in json.loads(state.read_bytes())["handles"]]
            except (OSError, ValueError):
                pass
            if not held:
                time.sleep(0.2)
        assert held, "the state file never held the handle"
        first.stop()

        second = Proc(env)
        assert second.wait_for(
            lambda x: "SHAPE HANDLE ADOPTED" in x and f"handle={handle}" in x
            and "source=proxy" in x, 30), second.lines
        assert second.wait_for(lambda x: "SHAPE HANDLES ADOPTED count=1" in x, 5)
    finally:
        for pr in (first, second):
            if pr is not None:
                pr.stop()


def test_unchanged_when_only_the_clock_moves(env):
    pep, _m, mono, wall, f, _w = env
    _seed(pep, mono, wall)
    assert pep.save_handle_state() == "ok"
    st, raw = f.stat().st_mtime_ns, f.read_bytes()
    mono.t += PERIOD
    wall.t += PERIOD
    assert pep.save_handle_state() == "unchanged"
    assert f.stat().st_mtime_ns == st and f.read_bytes() == raw
    assert pep._state_writes["unchanged"] == 1


def test_a_read_is_a_change(env):
    pep, _m, mono, wall, f, _w = env
    _seed(pep, mono, wall)
    assert pep.save_handle_state() == "ok"

    def seen():
        return {h["handle"]: h["last_seen_wall"]
                for h in json.loads(f.read_bytes())["handles"]}
    before = seen()["h-proxy"]
    mono.t += 5
    wall.t += 5
    pep.shape_age_check(TABLE, "h-proxy")
    assert pep.save_handle_state() == "ok"
    assert seen()["h-proxy"] > before


def test_failed_write_retries(env, tmp_path):
    pep, _m, mono, wall, f, _w = env
    _seed(pep, mono, wall)
    good = pep.HANDLE_STATE_FILE
    pep.HANDLE_STATE_FILE = str(tmp_path / "nope" / "handles.json")
    assert pep.save_handle_state() == "error"
    pep.HANDLE_STATE_FILE = good
    assert pep.save_handle_state() == "ok"
    assert f.exists()


def test_metrics_export_unchanged(env):
    pep, murl, mono, wall, _f, _w = env
    with urllib.request.urlopen(f"{murl}/metrics", timeout=10) as r:
        text = r.read().decode()
    lines = [ln for ln in text.splitlines()
             if ln.startswith("openddil_pep_handle_state_writes_total{")]
    assert sorted(re.search(r'outcome="(\w+)"', ln).group(1) for ln in lines) == [
        "error", "ok", "unchanged"]
    _seed(pep, mono, wall)
    assert pep.save_handle_state() == "ok"
    assert pep.save_handle_state() == "unchanged"
    assert pep.save_handle_state() == "unchanged"
    s = _series(murl)
    assert _g(s, "openddil_pep_handle_state_writes_total", outcome="unchanged") == 2
    assert _g(s, "openddil_pep_handle_state_writes_total", outcome="ok") == 1


def _adopt_one(pep, mono, wall, wipe, handle="young", source="proxy", rotated=False):
    pep.note_handle_born(TABLE, handle, source=source)
    if rotated:
        pep._rotated.add(handle)
    mono.t += 100
    wall.t += 100
    _bounce(pep, mono, wall, wipe, gap=50)
    assert pep.adopt_handle_state() == 1


def test_adopted_handle_rotates_once_on_first_read(env, caplog):
    pep, murl, mono, wall, _f, wipe = env
    caplog.set_level(logging.INFO, logger="pep")
    _adopt_one(pep, mono, wall, wipe)
    assert pep.shape_age_check(TABLE, "young") < PERIOD
    assert DELETES == ["young"]
    rot = _msgs(caplog, "SHAPE ROTATED")
    assert len(rot) == 1 and "reason=adopted" in rot[0]
    pep.shape_age_check(TABLE, "young")
    assert DELETES == ["young"]
    s = _series(murl)
    assert _g(s, "openddil_pep_shape_adopted_rotations_total", outcome="deleted") == 1


def test_adopted_rotated_in_file_is_not_rotated_again(env):
    pep, _m, mono, wall, _f, wipe = env
    _adopt_one(pep, mono, wall, wipe, rotated=True)
    assert "young" not in pep._adopted_pending
    pep.shape_age_check(TABLE, "young")
    assert DELETES == []


def test_new_handle_after_start_is_not_rotated_on_first_read(env):
    pep, _m, mono, wall, _f, wipe = env
    _adopt_one(pep, mono, wall, wipe)
    pep.note_handle_born(TABLE, "fresh")
    mono.t += 1
    pep.shape_age_check(TABLE, "fresh")
    assert DELETES == []
    assert "fresh" not in pep._adopted_pending


def test_rotation_off_adopted_not_deleted(env):
    pep, _m, mono, wall, _f, wipe = env
    _adopt_one(pep, mono, wall, wipe)
    saved = (pep.SHAPE_ROTATE_S, pep.SHAPE_CEILING_S)
    pep.SHAPE_ROTATE_S = 0
    pep.SHAPE_CEILING_S = CEILING
    try:
        pep.shape_age_check(TABLE, "young")
    finally:
        pep.SHAPE_ROTATE_S, pep.SHAPE_CEILING_S = saved
    assert DELETES == []
    assert "young" not in pep._adopted_pending


def test_bounded_adopted_handle_rotates_on_first_answer(env):
    pep, _m, mono, wall, _f, wipe = env
    _adopt_one(pep, mono, wall, wipe, handle="b1", source="bounded")
    new, rotate, _age = pep.note_handle_born(TABLE, "b1", source="bounded")
    assert (new, rotate) == (False, True)
    assert "b1" in pep._adopted_rotating            # the reason the caller takes
    new, rotate, _age = pep.note_handle_born(TABLE, "b1", source="bounded")
    assert rotate is False
    assert pep._take_adopted_rotating("b1") == "adopted"
    assert pep._take_adopted_rotating("b1") == ""
