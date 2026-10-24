"""Offline tests for exercise/stub_adapter.py's HTTP control surface.

Runs against a tiny stand-in "simulator" script (not the real
openddil-customer-bundle-example/tools/dis-sim/dis_sim.py -- that script is
owned by another change and only ever RUN, never imported from a test) so
these tests stay fast, deterministic, and need no other repo checked out.
The stand-in loops printing a heartbeat until signaled, which is all these
tests need: proof that run/pause/resume/stop/restart actually reach a real
child process via the real signals, and that STUB_LIE_STATE does what it
says without affecting the child's real state.

Run:  py -3 -m pytest exercise/test_stub_adapter.py -q
"""
from __future__ import annotations

import http.client
import importlib
import json
import os
import sys
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
FAKE_SIM = HERE / "_fixtures_fake_sim.py"


def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    port = _free_port()
    monkeypatch.setenv("STUB_PORT", str(port))
    monkeypatch.setenv("STUB_SIM_PATH", str(FAKE_SIM))
    monkeypatch.setenv("STUB_SIM_ARGS", "")
    monkeypatch.delenv("STUB_LIE_STATE", raising=False)
    sys.path.insert(0, str(HERE))
    sys.modules.pop("stub_adapter", None)
    mod = importlib.import_module("stub_adapter")

    import threading
    from http.server import ThreadingHTTPServer
    srv = ThreadingHTTPServer(("127.0.0.1", port), mod.Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield mod, port
    mod.SIM.stop()
    srv.shutdown()


def _post(port: int, path: str):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", path, body=b"")
    resp = conn.getresponse()
    body = json.loads(resp.read())
    conn.close()
    return resp.status, body


def _get(port: int, path: str):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path)
    resp = conn.getresponse()
    body = json.loads(resp.read())
    conn.close()
    return resp.status, body


def test_unknown_op_is_404_and_not_logged(adapter):
    _mod, port = adapter
    status, body = _post(port, "/wiggle")
    assert status == 404
    _, reqs = _get(port, "/requests")
    assert reqs["requests"] == []


def test_run_then_requests_log_grows_by_one(adapter):
    mod, port = adapter
    status, body = _post(port, "/run")
    assert status == 200
    assert body["op"] == "run"
    assert body["state"] == "running"
    _, reqs = _get(port, "/requests")
    assert len(reqs["requests"]) == 1
    assert reqs["requests"][0]["op"] == "run"
    assert mod.SIM.actual_state() == "running"


def test_pause_then_resume_toggle_actual_state(adapter):
    mod, port = adapter
    _post(port, "/run")
    status, body = _post(port, "/pause")
    assert status == 200
    assert body["state"] == "paused"
    assert mod.SIM.actual_state() == "paused"

    status, body = _post(port, "/resume")
    assert body["state"] == "running"
    assert mod.SIM.actual_state() == "running"


def test_stop_then_requests_count_and_actual_state(adapter):
    mod, port = adapter
    _post(port, "/run")
    status, body = _post(port, "/stop")
    assert status == 200
    assert body["state"] == "stopped"
    assert mod.SIM.actual_state() == "stopped"
    _, reqs = _get(port, "/requests")
    assert [r["op"] for r in reqs["requests"]] == ["run", "stop"]


def test_restart_stops_old_pid_and_starts_a_new_one(adapter):
    mod, port = adapter
    _post(port, "/run")
    first_pid = mod.SIM.proc.pid
    status, body = _post(port, "/restart")
    assert status == 200
    assert body["pid"] != first_pid
    assert mod.SIM.actual_state() == "running"


def test_stub_lie_state_claims_running_while_actually_paused(adapter, monkeypatch):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_LIE_STATE", "running")
    _post(port, "/run")
    status, body = _post(port, "/pause")
    # The lie: response body says "running" ...
    assert body["state"] == "running"
    # ... while the process itself is actually paused. This is the whole
    # point of STUB_LIE_STATE -- control.py never reads this field at all,
    # so the lie must never be able to reach the UI (see test_control.py's
    # own proof that call_adapter only returns a status code).
    assert mod.SIM.actual_state() == "paused"


def test_pause_without_a_running_child_is_a_no_op_not_an_error(adapter):
    mod, port = adapter
    status, body = _post(port, "/pause")
    assert status == 200
    assert mod.SIM.actual_state() == "stopped"


# =============================================================================
# STUB_SIM_ARGS_CYCLE -- the k-th child start takes element (k-1) % len
# =============================================================================

def _capture_argv(mod, monkeypatch):
    argvs = []
    real = mod.subprocess.Popen

    def spy(argv, *a, **kw):
        argvs.append(list(argv))
        return real(argv, *a, **kw)

    monkeypatch.setattr(mod.subprocess, "Popen", spy)
    return argvs


def test_args_cycle_selects_element_per_run_and_wraps(adapter, monkeypatch):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_SIM_ARGS_CYCLE", ["--a 1", "--b 2"])
    argvs = _capture_argv(mod, monkeypatch)
    seen = []
    for _ in range(3):
        _post(port, "/run")
        _post(port, "/stop")
    _, reqs = _get(port, "/requests")
    seen = [r["args_index"] for r in reqs["requests"] if r["op"] == "run"]
    assert seen == [0, 1, 0]
    assert [a[2:] for a in argvs] == [["--a", "1"], ["--b", "2"], ["--a", "1"]]


def test_args_cycle_unset_uses_sim_args_and_index_is_null(adapter, monkeypatch):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_SIM_ARGS", ["--only", "x"])
    argvs = _capture_argv(mod, monkeypatch)
    _post(port, "/run")
    _post(port, "/stop")
    _post(port, "/run")
    _, reqs = _get(port, "/requests")
    assert all(r["args_index"] is None for r in reqs["requests"] if r["op"] == "run")
    assert [a[2:] for a in argvs] == [["--only", "x"], ["--only", "x"]]


def test_args_cycle_is_parsed_from_env_json(monkeypatch):
    monkeypatch.setenv("STUB_SIM_PATH", str(FAKE_SIM))
    monkeypatch.setenv("STUB_SIM_ARGS_CYCLE", '["--a 1", "--b 2"]')
    sys.path.insert(0, str(HERE))
    sys.modules.pop("stub_adapter", None)
    mod = importlib.import_module("stub_adapter")
    assert mod.STUB_SIM_ARGS_CYCLE == ["--a 1", "--b 2"]
    sys.modules.pop("stub_adapter", None)


# =============================================================================
# run reports a dead start: missing script / child exits inside the settle
# =============================================================================

def _exit_script(tmp_path, code=3):
    p = tmp_path / "exits.py"
    p.write_text(f"import sys\nsys.exit({code})\n")
    return p


def test_run_missing_script_is_502_and_starts_nothing(adapter, monkeypatch, tmp_path):
    mod, port = adapter
    missing = tmp_path / "nope.py"
    monkeypatch.setattr(mod, "STUB_SIM_PATH", str(missing))
    status, body = _post(port, "/run")
    assert status == 502
    assert body["op"] == "run" and body["error"] == "sim script not found"
    assert body["path"] == str(missing)
    assert mod.SIM.proc is None
    _, reqs = _get(port, "/requests")
    assert reqs["requests"][-1]["ok"] is False
    assert reqs["requests"][-1]["error"] == "sim script not found"


def test_run_child_exiting_at_once_is_502_with_rc(adapter, monkeypatch, tmp_path):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_SIM_PATH", str(_exit_script(tmp_path, 3)))
    monkeypatch.setattr(mod, "STUB_RUN_SETTLE_S", 1.5)
    status, body = _post(port, "/run")
    assert status == 502
    assert body == {"op": "run", "error": "sim exited at start", "rc": 3}
    _, reqs = _get(port, "/requests")
    last = reqs["requests"][-1]
    assert last["ok"] is False and last["rc"] == 3


def test_run_live_child_is_200_ok_true_and_rerun_is_200(adapter, monkeypatch):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_RUN_SETTLE_S", 0.3)
    status, body = _post(port, "/run")
    assert status == 200 and body["state"] == "running"
    t0 = time.time()
    status2, _ = _post(port, "/run")  # already alive: no settle wait
    assert status2 == 200 and time.time() - t0 < 0.25
    _, reqs = _get(port, "/requests")
    assert [r["ok"] for r in reqs["requests"]] == [True, True]


def test_failed_start_still_advances_args_cycle(adapter, monkeypatch, tmp_path):
    mod, port = adapter
    monkeypatch.setattr(mod, "STUB_RUN_SETTLE_S", 1.5)
    monkeypatch.setattr(mod, "STUB_SIM_ARGS_CYCLE", ["--a", "--b"])
    monkeypatch.setattr(mod, "STUB_SIM_PATH", str(_exit_script(tmp_path, 1)))
    _post(port, "/run")
    monkeypatch.setattr(mod, "STUB_SIM_PATH", str(FAKE_SIM))
    _post(port, "/run")
    _, reqs = _get(port, "/requests")
    assert [r["args_index"] for r in reqs["requests"]] == [0, 1]
