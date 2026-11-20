"""`_follow_shape` parses the shape body as it arrives (`_iter_shape_messages`)
instead of holding the whole body and the whole parsed list.

Pins: the rows match what the read-it-all algorithm gave, the parser gives the
same answer at every chunk size (a multibyte character may be split), a
truncated body never yields a half-read value, malformed bodies raise the one
shape error, must-refetch discards what came before it, and every read on the
response is bounded by STREAM_CHUNK.

Run:  py -3 -m pytest gateway/test_pep_follow_shape.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

UP_TO_DATE = {"headers": {"control": "up-to-date"}}
MUST_REFETCH = {"headers": {"control": "must-refetch"}}


def _op(operation, value, key="row-1"):
    return {"key": key, "value": value, "headers": {"operation": operation}}


state = {"responses": [], "requests": []}


class FakeElectric(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        state["requests"].append(self.path)
        if not state["responses"]:
            self.send_response(500)
            self.end_headers()
            return
        status, messages, extra_headers = state["responses"].pop(0)
        body = b"" if messages is None else json.dumps(messages).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)


@pytest.fixture(scope="module")
def pep_module():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeElectric)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{srv.server_port}"
    os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://topaz.invalid:9")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above
    yield pep
    srv.shutdown()


@pytest.fixture(autouse=True)
def _reset_state():
    state["responses"] = []
    state["requests"] = []
    yield


class FakeResp:
    """read(n) returns at most k bytes and records every argument."""

    def __init__(self, body: bytes, k: int | None = None):
        self._body, self._k, self.args = body, k, []

    def read(self, n=None):
        self.args.append(n)
        take = n if self._k is None else min(n, self._k)
        out, self._body = self._body[:take], self._body[take:]
        return out


def _run(pep, body, k=None):
    return list(pep._iter_shape_messages(FakeResp(body, k)))


def test_equivalence(pep_module):
    state["responses"] = [
        (200, [_op("insert", {"asset_id": "asset-1", "n": 1, "x": "a"}, "k1"),
               _op("insert", {"asset_id": "asset-1", "n": 2}, "k2"),
               _op("update", {"n": 5}, "k1")],
         {"electric-handle": "h1", "electric-offset": "10"}),
        (200, [_op("delete", None, "k2"),
               _op("update", {"x": "b"}, "k1"), "junk", UP_TO_DATE],
         {"electric-handle": "h1", "electric-offset": "20"}),
    ]
    rows = pep_module._follow_shape("asset_cm_state", "w", None, "asset-1")
    assert rows == [{"asset_id": "asset-1", "n": 5, "x": "b"}]
    assert "handle=h1" in state["requests"][1] and "offset=10" in state["requests"][1]


@pytest.mark.parametrize("k", [1, 2, 7, 65536])
def test_chunk_sizes(pep_module, k):
    msgs = [_op("insert", {"name": "café → edge-a", "n": 12345}, "k1"),
            _op("insert", {"v": [1, 2.5, None, True]}, "k2"), UP_TO_DATE]
    body = json.dumps(msgs, ensure_ascii=False, indent=1).encode("utf-8")
    assert _run(pep_module, body, k) == msgs


def test_truncation_guard(pep_module):
    class Split(FakeResp):
        def __init__(self):
            super().__init__(b"")
            self.parts = [b"[12", b"3]"]

        def read(self, n=None):
            return self.parts.pop(0) if self.parts else b""

    assert list(pep_module._iter_shape_messages(Split())) == [123]
    with pytest.raises(pep_module.ElectricUnavailable):
        _run(pep_module, b'[{"a":1}')


@pytest.mark.parametrize("body", [b"{}", b"not json", b"[1] x", b"", b"[1,"])
def test_shape_errors(pep_module, body):
    with pytest.raises(pep_module.ElectricUnavailable,
                       match="unexpected shape response shape"):
        _run(pep_module, body)


def test_must_refetch(pep_module):
    state["responses"] = [
        (200, [_op("insert", {"v": 1}, "old"), MUST_REFETCH, _op("insert", {"v": 9}, "z")],
         {"electric-handle": "h1", "electric-offset": "10"}),
        (200, [_op("insert", {"v": 2}, "new"), UP_TO_DATE],
         {"electric-handle": "h2", "electric-offset": "5"}),
    ]
    assert pep_module._follow_shape("t", "w", None, "d") == [{"v": 2}]
    assert "offset=-1" in state["requests"][1]


def test_bounded_reads(pep_module):
    resp = FakeResp(json.dumps([_op("insert", {"v": 1}), UP_TO_DATE]).encode(), 3)
    list(pep_module._iter_shape_messages(resp))
    assert resp.args
    assert all(a == pep_module.STREAM_CHUNK for a in resp.args)


def test_empty_array(pep_module):
    assert _run(pep_module, b" [ ] \n") == []
    state["responses"] = [
        (200, [], {"electric-handle": "h1", "electric-offset": "1"}),
        (200, [UP_TO_DATE], {"electric-handle": "h1", "electric-offset": "2"}),
    ]
    assert pep_module._follow_shape("t", "w", None, "d") == []
