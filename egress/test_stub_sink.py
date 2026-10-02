"""Unit tests for egress/stub_sink.py.

Run: `python -m pytest egress/test_stub_sink.py -q` from openddil-demo/.

The server is started on port 0 (OS-assigned) in a background thread against
a temp directory, so no fixed port and no state leaks between tests.
"""
from __future__ import annotations

import json
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
