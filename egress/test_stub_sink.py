"""Unit tests for egress/stub_sink.py.

Run: `python -m pytest egress/test_stub_sink.py -q` from openddil-demo/.

The server is started on port 0 (OS-assigned) in a background thread against
a temp directory, so no fixed port and no state leaks between tests.
"""
from __future__ import annotations

import json
import logging
import re
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from stub_sink import make_server  # noqa: E402


def _start(directory, **kwargs):
    server = make_server(directory, host="127.0.0.1", port=0, **kwargs)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop(server, thread):
    server.shutdown()
    thread.join(timeout=5)
    server.server_close()


@pytest.fixture
def running_server(tmp_path):
    server, thread = _start(tmp_path)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield base_url, tmp_path
    finally:
        _stop(server, thread)


def _post(base_url, body, headers=None):
    data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/ingest", data=data, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, None


def _get(base_url, path):
    with urllib.request.urlopen(f"{base_url}{path}", timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode())


def test_healthz_is_200(running_server):
    base_url, _ = running_server
    status, _ = _get(base_url, "/healthz")
    assert status == 200


def test_two_same_id_one_different_total_and_distinct_ids(running_server):
    base_url, _ = running_server
    _post(base_url, {"id": "r1", "kind": "KindA"})
    _post(base_url, {"id": "r1", "kind": "KindA"})
    _post(base_url, {"id": "r2", "kind": "KindA"})

    status, summary = _get(base_url, "/received")
    assert status == 200
    assert summary["total"] == 3
    assert summary["distinct_ids"] == 2


def test_by_kind_correct(running_server):
    base_url, _ = running_server
    _post(base_url, {"id": "r1", "kind": "KindA"})
    _post(base_url, {"id": "r2", "kind": "KindA"})
    _post(base_url, {"id": "r3", "kind": "KindB"})

    _, summary = _get(base_url, "/received")
    assert summary["by_kind"] == {"KindA": 2, "KindB": 1}


def test_non_json_body_is_400_and_not_recorded(running_server):
    base_url, _ = running_server
    status, _ = _post(base_url, b"not-json-at-all", headers={"Content-Type": "application/json"})
    assert status == 400

    _, summary = _get(base_url, "/received")
    assert summary["total"] == 0


def test_restart_over_same_dir_keeps_counts(tmp_path):
    server1, thread1 = _start(tmp_path)
    base1 = f"http://127.0.0.1:{server1.server_address[1]}"
    _post(base1, {"id": "r1", "kind": "KindA"})
    _post(base1, {"id": "r2", "kind": "KindA"})
    _stop(server1, thread1)

    server2, thread2 = _start(tmp_path)
    try:
        base2 = f"http://127.0.0.1:{server2.server_address[1]}"
        _, summary = _get(base2, "/received")
        assert summary["total"] == 2
        assert summary["distinct_ids"] == 2
    finally:
        _stop(server2, thread2)


def test_artifacts_unset_env_serves_empty_items(running_server):
    base_url, _ = running_server
    status, body = _get(base_url, "/artifacts")
    assert status == 200
    assert body == {"items": []}


def test_artifacts_missing_file_serves_empty_items(tmp_path):
    server, thread = _start(tmp_path, artifacts_path=str(tmp_path / "does-not-exist.json"))
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, body = _get(base_url, "/artifacts")
        assert status == 200
        assert body == {"items": []}
    finally:
        _stop(server, thread)


def test_artifacts_served_from_configured_path(tmp_path):
    artifacts_path = tmp_path / "artifacts.json"
    items = [{"id": "a1", "kind": "KindA"}, {"id": "a2", "kind": "KindA"}]
    artifacts_path.write_text(json.dumps(items), encoding="utf-8")

    server, thread = _start(tmp_path, artifacts_path=str(artifacts_path))
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, body = _get(base_url, "/artifacts")
        assert status == 200
        assert body == {"items": items}
    finally:
        _stop(server, thread)


def test_authorization_value_never_appears_in_file_or_logs(running_server, caplog):
    base_url, data_dir = running_server
    secret = "super-secret-token-xyz"

    with caplog.at_level("DEBUG"):
        status, _ = _post(
            base_url, {"id": "r1", "kind": "KindA"},
            headers={"Authorization": f"Bearer {secret}"},
        )
    assert status == 202

    received_file = data_dir / "received.jsonl"
    assert secret not in received_file.read_text()
    assert secret not in caplog.text


# --- responder -------------------------------------------------------------

_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

_TEMPLATE = {
    "kind": "answer",
    "state": "open",
    "work_order": {"parts": [{"part_ref": "", "qty": 1}]},
    "approval_chain": [{"role": "a", "decided_at": ""}, {"role": "b", "decided_at": ""}],
}

_RESPONSE = {
    "body_field": "payload",
    "kind_field": "content_kind", "kind": "fault-event",
    "id": {"pointer": "/action_id", "prefix": "act-", "from": "/event_id"},
    "copy": {
        "/event_id": "/event_id",
        "/asset_id": "/asset_id",
        "/work_order/parts/0/part_ref": "/picture/spare/part_ref",
    },
    "stamp": ["/approval_chain/0/decided_at", "/approval_chain/1/decided_at"],
    "template": _TEMPLATE,
}

_FIXED = {"id": "fixed-1"}


def _config_files(tmp_path, response):
    artifacts = tmp_path / "artifacts.json"
    artifacts.write_text(json.dumps([_FIXED]), encoding="utf-8")
    resp = tmp_path / "response.json"
    resp.write_text(response if isinstance(response, str) else json.dumps(response),
                    encoding="utf-8")
    return artifacts, resp


def _envelope(event_id="ev-1", kind="fault-event", **event_extra):
    event = {"event_id": event_id, "asset_id": "asset-9",
             "picture": {"spare": {"part_ref": "P-42"}}, **event_extra}
    return {"content_kind": kind, "payload": event}


@pytest.fixture
def responding(tmp_path):
    data = tmp_path / "data"
    artifacts, resp = _config_files(tmp_path, _RESPONSE)
    server, thread = _start(data, artifacts_path=artifacts, response_path=resp)
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", data
    finally:
        _stop(server, thread)


def test_no_response_path_serves_fixed_list_only(tmp_path):
    artifacts, _ = _config_files(tmp_path, _RESPONSE)
    server, thread = _start(tmp_path / "data", artifacts_path=artifacts, response_path=None)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        _post(base_url, _envelope())
        assert _get(base_url, "/artifacts")[1] == {"items": [_FIXED]}
        assert _get(base_url, "/received")[1]["answered"] == 0
    finally:
        _stop(server, thread)


def test_event_is_answered_from_template(responding):
    base_url, _ = responding
    assert _post(base_url, _envelope("ev-1"))[0] == 202
    items = _get(base_url, "/artifacts")[1]["items"]
    assert len(items) == 2 and items[0] == _FIXED
    answer = items[1]
    assert answer["action_id"] == "act-ev-1"
    assert answer["event_id"] == "ev-1"
    assert answer["asset_id"] == "asset-9"
    assert answer["work_order"]["parts"][0]["part_ref"] == "P-42"
    for i in (0, 1):
        assert _STAMP_RE.match(answer["approval_chain"][i]["decided_at"])
    assert answer["kind"] == "answer" and answer["state"] == "open"
    assert answer["work_order"]["parts"][0]["qty"] == 1
    assert [c["role"] for c in answer["approval_chain"]] == ["a", "b"]


def test_same_event_twice_is_one_answer(responding):
    base_url, _ = responding
    _post(base_url, _envelope("ev-1"))
    _post(base_url, _envelope("ev-1"))
    summary = _get(base_url, "/received")[1]
    assert summary["total"] == 2 and summary["answered"] == 1
    assert len(_get(base_url, "/artifacts")[1]["items"]) == 2


def test_wrong_kind_is_recorded_but_not_answered(responding):
    base_url, _ = responding
    _post(base_url, _envelope("ev-1", kind="other"))
    summary = _get(base_url, "/received")[1]
    assert summary["total"] == 1 and summary["answered"] == 0


def test_missing_copy_source_warns_with_pointer_not_body(responding, caplog):
    base_url, _ = responding
    env = _envelope("ev-7", secret_note="do-not-log-me")
    del env["payload"]["asset_id"]
    with caplog.at_level(logging.WARNING, logger="egress.stub_sink"):
        _post(base_url, env)
    summary = _get(base_url, "/received")[1]
    assert summary["total"] == 1 and summary["answered"] == 0
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "/asset_id" in message
    assert "do-not-log-me" not in message and "P-42" not in message


def test_restart_regenerates_identical_answers(tmp_path):
    data = tmp_path / "data"
    artifacts, resp = _config_files(tmp_path, _RESPONSE)
    server, thread = _start(data, artifacts_path=artifacts, response_path=resp)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        _post(base_url, _envelope("ev-1"))
        _post(base_url, _envelope("ev-2"))
        before = _get(base_url, "/artifacts")[1]
    finally:
        _stop(server, thread)
    server, thread = _start(data, artifacts_path=artifacts, response_path=resp)
    try:
        after = _get(f"http://127.0.0.1:{server.server_address[1]}", "/artifacts")[1]
    finally:
        _stop(server, thread)
    assert len(before["items"]) == 3
    assert json.dumps(after, sort_keys=True) == json.dumps(before, sort_keys=True)


@pytest.mark.parametrize("response", [
    "{not json",
    {**_RESPONSE, "template": ["not", "an", "object"]},
    {k: v for k, v in _RESPONSE.items() if k != "id"},
    {k: v for k, v in _RESPONSE.items() if k != "kind_field"},
], ids=["invalid-json", "template-not-object", "id-missing", "kind-without-kind-field"])
def test_broken_response_config_fails_startup(tmp_path, response):
    _, resp = _config_files(tmp_path, response)
    with pytest.raises(ValueError):
        make_server(tmp_path / "data", host="127.0.0.1", port=0, response_path=resp)
