"""`read_cm_visibility_row` must follow Electric's shape log to up-to-date,
not stop at the first response.

Electric answers an `offset=-1` GET with the snapshot taken when the shape
was first CREATED -- a shape is cached, so a later request for the same
table+where gets that same original snapshot back, not the table's current
state. Anything written since then lives only in the shape's log, reached by
following `electric-handle`/`electric-offset`. These tests drive a fake
Electric through canned header+body sequences to pin: a snapshot followed by
a log update/insert/delete must be reflected in the row the function
returns, an update merges rather than replaces, a transient 409 restarts
once, and the whole thing fails closed -- never returning a possibly stale
row -- on a double 409 or on 20 requests with no up-to-date.

Run:  py -3 -m pytest gateway/test_pep_cm_visibility_read.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ASSET = "dis:1:1:4773"
NATIONS = ["ATL"]

UP_TO_DATE = {"headers": {"control": "up-to-date"}}
MUST_REFETCH = {"headers": {"control": "must-refetch"}}


def _op(operation, value, key="row-1"):
    return {"key": key, "value": value, "headers": {"operation": operation}}


# Each queued response is (status, body_messages_or_None, extra_headers).
state = {"responses": [], "requests": []}


class FakeElectric(BaseHTTPRequestHandler):
    """Serves exactly the canned sequence the test queued, recording every
    request path so a test can assert the handle/offset it was given."""

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


def _serve() -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeElectric)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_module():
    srv = _serve()
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


def _queue(*responses):
    state["responses"].extend(responses)


ROW_A = {"asset_id": ASSET, "updated_at": "2026-01-01T20:19:25Z",
          "installed": [{"slot_id": "ENG-1"}], "manual_discrepancies": []}


def test_log_update_after_snapshot_is_reflected(pep_module):
    """THE RED TEST: against the current one-shot code this returns row A's
    stale snapshot value; it must return the log's updated value instead."""
    _queue(
        (200, [_op("insert", ROW_A)], {"electric-handle": "h1", "electric-offset": "10"}),
        (200, [_op("update", {"updated_at": "2026-01-01T20:30:16Z"}), UP_TO_DATE],
         {"electric-handle": "h1", "electric-offset": "20"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row["updated_at"] == "2026-01-01T20:30:16Z"


def test_new_asset_becomes_visible(pep_module):
    _queue(
        (200, [], {"electric-handle": "h2", "electric-offset": "5"}),
        (200, [_op("insert", ROW_A), UP_TO_DATE], {"electric-handle": "h2", "electric-offset": "6"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row is not None
    assert row["asset_id"] == ASSET


def test_log_delete_after_snapshot_is_honoured(pep_module):
    _queue(
        (200, [_op("insert", ROW_A)], {"electric-handle": "h3", "electric-offset": "7"}),
        (200, [_op("delete", ROW_A), UP_TO_DATE], {"electric-handle": "h3", "electric-offset": "8"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row is None


def test_log_delete_without_a_value_is_still_honoured(pep_module):
    _queue(
        (200, [_op("insert", ROW_A)], {"electric-handle": "h3b", "electric-offset": "7"}),
        (200, [{"key": "row-1", "headers": {"operation": "delete"}}, UP_TO_DATE],
         {"electric-handle": "h3b", "electric-offset": "8"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row is None


def test_partial_update_merges_not_replaces(pep_module):
    _queue(
        (200, [_op("insert", ROW_A)], {"electric-handle": "h4", "electric-offset": "9"}),
        (200, [_op("update", {"manual_discrepancies": ["FC-100"]}), UP_TO_DATE],
         {"electric-handle": "h4", "electric-offset": "11"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row["manual_discrepancies"] == ["FC-100"]
    assert row["installed"] == [{"slot_id": "ENG-1"}]
    assert row["asset_id"] == ASSET


def test_single_409_restarts_and_succeeds(pep_module):
    _queue(
        (409, None, {}),
        (200, [_op("insert", ROW_A), UP_TO_DATE], {"electric-handle": "h5", "electric-offset": "1"}),
    )
    row = pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert row["asset_id"] == ASSET


def test_second_409_raises_electric_unavailable(pep_module):
    _queue((409, None, {}), (409, None, {}))
    with pytest.raises(pep_module.ElectricUnavailable):
        pep_module.read_cm_visibility_row(ASSET, NATIONS)


def test_no_up_to_date_within_20_requests_raises(pep_module):
    _queue(*[
        (200, [], {"electric-handle": "hN", "electric-offset": str(i)})
        for i in range(25)
    ])
    with pytest.raises(pep_module.ElectricUnavailable):
        pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert len(state["requests"]) == 20


def test_second_request_carries_handle_and_offset_from_first_response(pep_module):
    _queue(
        (200, [_op("insert", ROW_A)], {"electric-handle": "handle-xyz", "electric-offset": "42"}),
        (200, [UP_TO_DATE], {"electric-handle": "handle-xyz", "electric-offset": "43"}),
    )
    pep_module.read_cm_visibility_row(ASSET, NATIONS)
    assert len(state["requests"]) == 2
    first = urllib.parse.parse_qs(urllib.parse.urlsplit(state["requests"][0]).query)
    second = urllib.parse.parse_qs(urllib.parse.urlsplit(state["requests"][1]).query)
    assert first["offset"] == ["-1"]
    assert "handle" not in first
    assert second["handle"] == ["handle-xyz"]
    assert second["offset"] == ["42"]
