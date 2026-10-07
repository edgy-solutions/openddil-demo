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
