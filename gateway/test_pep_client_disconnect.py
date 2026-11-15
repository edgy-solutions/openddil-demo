"""A dropped client is counted and logged at DEBUG, not printed as a traceback.

Runs the real `_PepHTTPServer` with the real `Pep` handler on port 0.

Run:  py -3 -m pytest gateway/test_pep_client_disconnect.py
"""
from __future__ import annotations

import logging
import os
import re
import socket
import struct
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def pep_module():
    os.environ.setdefault("OPENDDIL_ELECTRIC_URL", "http://127.0.0.1:9")
    os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://127.0.0.1:9")
    for k in ("OPENDDIL_SESSION_TTL_SECONDS", "OPENDDIL_SESSION_MAX_SECONDS",
              "OPENDDIL_SESSION_MODE", "OPENDDIL_OIDC_ISSUER"):
        os.environ.pop(k, None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.PEP_TIER = "edge-test"
    yield pep


@pytest.fixture
def server(pep_module):
    pep = pep_module
    with pep._client_lock:
        pep._client_disconnects.update({"pep": 0, "metrics": 0})
    srv = pep._PepHTTPServer(("127.0.0.1", 0), pep.Pep)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield srv
    srv.shutdown()
    srv.server_close()
    th.join(timeout=5)


def _wait(pred, timeout=5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def _reset_client(port: int) -> None:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.sendall(b"GET /v1/sha")                       # a partial request line
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    s.close()                                       # RST, not FIN


def test_dropped_client_is_counted_quietly(pep_module, server, capfd, caplog):
    pep = pep_module
    caplog.set_level(logging.DEBUG, logger="pep")
    _reset_client(server.server_port)
    assert _wait(lambda: pep._client_disconnects["pep"] == 1)
    assert pep._client_disconnects["metrics"] == 0
    time.sleep(0.2)                                 # let any traceback land
    err = capfd.readouterr().err
    assert "Traceback" not in err
    lines = [r for r in caplog.records if "client disconnected" in r.getMessage()]
    assert len(lines) == 1 and lines[0].levelno == logging.DEBUG
    msg = lines[0].getMessage()
    assert msg.startswith("client disconnected server=pep error=")
    assert "127.0.0.1" not in msg


def test_other_errors_keep_their_traceback(pep_module, server, capfd):
    pep = pep_module
    try:
        raise ValueError("boom")
    except ValueError:
        server.handle_error(None, ("127.0.0.1", 1))
    err = capfd.readouterr().err
    assert "Traceback" in err and "ValueError: boom" in err
    assert pep._client_disconnects == {"pep": 0, "metrics": 0}


def test_counter_series_over_http(pep_module):
    pep = pep_module
    with pep._client_lock:
        pep._client_disconnects.update({"pep": 0, "metrics": 0})
    metrics = pep.start_metrics_server(0)
    try:
        url = f"http://127.0.0.1:{metrics.server_port}/metrics"

        def series():
            with urllib.request.urlopen(url, timeout=10) as r:
                text = r.read().decode()
            assert "# TYPE openddil_pep_client_disconnects_total counter" in text
            out = {}
            for line in text.splitlines():
                m = re.fullmatch(r"openddil_pep_client_disconnects_total\{(.*)\} (\S+)", line)
                if m:
                    out[tuple(sorted(re.findall(r'(\w+)="([^"]*)"', m.group(1))))] = float(m.group(2))
            return out

        key = lambda srv: (("server", srv), ("tier", "edge-test"))  # noqa: E731
        assert series() == {key("pep"): 0, key("metrics"): 0}
        _reset_client(metrics.server_port)          # the metrics listener counts its own
        assert _wait(lambda: pep._client_disconnects["metrics"] == 1)
        assert series() == {key("pep"): 0, key("metrics"): 1}
    finally:
        metrics.shutdown()
        metrics.server_close()
