"""Unit tests for egress/forwarder.py.

Run: `python -m pytest egress/test_forwarder.py -q` from openddil-demo/.

No Kafka, no network: `run_once` is exercised with a fake consumer (the same
injection seam test_routes.py uses) and an injected HTTP post function and
sleep function, so neither `confluent_kafka` nor `urllib` ever makes a real
call here.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from forwarder import (  # noqa: E402
    Envelope,
    ForwardConfigError,
    ForwardRoute,
    build_envelope,
    load_forward_config,
    run_once,
)


def _write_config(tmp_path, entries) -> str:
    path = tmp_path / "forward.json"
    path.write_text(json.dumps(entries))
    return str(path)


def _route(**over):
    base = dict(name="to-a", sink_topic="sink-a", url="http://sink.invalid/ingest", kind="KindA")
    base.update(over)
    return ForwardRoute(**base)


# --- load_forward_config / envelopes ---------------------------------------

def test_default_envelope_exact_json(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA"},
    ])
    [route] = load_forward_config(path)
    assert route.envelope == Envelope()

    env = build_envelope(route, "k1", {"a": 1})
    assert json.dumps(env, separators=(",", ":")) == '{"kind":"KindA","id":"k1","payload":{"a":1}}'


def test_configured_envelope_field_names(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"kind_field": "type", "id_field": "recordId", "body_field": "data"}},
    ])
    [route] = load_forward_config(path)
    env = build_envelope(route, "k1", {"a": 1})
    assert env == {"type": "KindA", "recordId": "k1", "data": {"a": 1}}


def test_duplicate_name_fails_naming_the_entry(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA"},
        {"name": "f1", "sink_topic": "sink-b", "url": "http://sink.invalid/ingest", "kind": "KindA"},
    ])
    with pytest.raises(ForwardConfigError) as exc:
        load_forward_config(path)
    assert "f1" in str(exc.value)


# --- run_once: the fake consumer/HTTP seam ---------------------------------

class _FakeMessage:
    def __init__(self, topic, key, value):
        self._topic, self._key, self._value = topic, key, value

    def topic(self):
        return self._topic

    def key(self):
        return self._key

    def value(self):
        return self._value

    def error(self):
        return None


class _FakeConsumer:
    def __init__(self, messages):
        self._messages = list(messages)
        self.committed = []

    def poll(self, timeout):
        if not self._messages:
            return None
        return self._messages.pop(0)

    def commit(self, msg, asynchronous=False):
        self.committed.append(msg)


def _decode(payload: bytes) -> dict:
    return json.loads(payload.decode("utf-8"))


def test_2xx_commits_once_and_counts_delivered():
    route = _route()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append((url, data, headers))
        return 200, b"ok"

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("sleep should not be called"),
        poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert len(posts) == 1
    assert counts.get("delivered") == 1
    assert consumer.committed == [message]


def test_503_then_200_retries_with_backoff_then_commits_once():
    route = _route()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    statuses = iter([503, 200])
    posts = []

    def fake_post(url, data, headers):
        posts.append((url, data, headers))
        return next(statuses), b""

    slept = []

    def fake_sleep(d):
        slept.append(d)
        # Not committed yet: the 503 must not have been committed while a
        # retry for the same record is still in flight.
        assert consumer.committed == []

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=fake_sleep,
        poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert len(posts) == 2
    assert len(slept) == 1
    assert counts.get("retried") == 1
    assert counts.get("delivered") == 1
    assert consumer.committed == [message]


def test_400_is_rejected_committed_no_retry():
    route = _route()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 400, b"nope"

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("400 must not retry"),
        poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert len(posts) == 1
    assert counts.get("rejected") == 1
    assert consumer.committed == [message]


def test_not_json_counts_undecodable_and_commits():
    route = _route()
    message = _FakeMessage("sink-a", b"k1", b"not-json-at-all")
    consumer = _FakeConsumer([message])
    counts: dict[str, int] = {}

    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda *a: pytest.fail("undecodable must not post"),
        sleep=lambda d: pytest.fail("undecodable must not sleep"),
        poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert counts.get("undecodable") == 1
    assert consumer.committed == [message]


def test_token_file_present_sets_authorization_header(tmp_path):
    token_path = tmp_path / "token.txt"
    token_path.write_text("secret-abc\n")
    route = _route(token_file=str(token_path))
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(headers)
        return 200, b"ok"

    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts,
    )

    assert posts[0]["Authorization"] == "Bearer secret-abc"


def test_missing_token_file_is_not_posted_counted_no_credential_not_committed(tmp_path):
    token_path = tmp_path / "token.txt"  # does not exist yet
    route = _route(token_file=str(token_path))
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    events = []

    def fake_post(url, data, headers):
        events.append("post")
        return 200, b"ok"

    def fake_sleep(d):
        events.append("sleep")
        # Not yet committed while the credential is still missing.
        assert consumer.committed == []
        token_path.write_text("now-available\n")  # the credential arrives

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=fake_sleep, poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert events == ["sleep", "post"]  # not posted until the credential appears
    assert counts.get("no_credential") == 1
    assert counts.get("delivered") == 1
    assert consumer.committed == [message]


# --- auth (client_credentials): config, exclusivity, delivery --------------

def test_auth_and_token_file_together_is_a_config_error(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest",
         "kind": "KindA", "token_file": "/etc/token",
         "auth": {"token_url": "http://example.invalid/t", "client_id": "c1",
                   "client_secret_file": "/etc/secret"}},
    ])
    with pytest.raises(ForwardConfigError, match="token_file and auth are exclusive"):
        load_forward_config(path)


def test_auth_bad_shape_raises_forward_config_error_naming_entry(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest",
         "kind": "KindA", "auth": {"token_url": "http://example.invalid/t"}},
    ])
    with pytest.raises(ForwardConfigError) as exc:
        load_forward_config(path)
    assert "f1" in str(exc.value)


def test_auth_parses_into_route(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest",
         "kind": "KindA",
         "auth": {"token_url": "http://example.invalid/t", "client_id": "c1",
                   "client_secret_file": "/etc/secret"}},
    ])
    [route] = load_forward_config(path)
    assert route.token_file is None
    assert route.auth.token_url == "http://example.invalid/t"
    assert route.auth.client_id == "c1"
    assert route.auth.client_secret_file == "/etc/secret"


class _FakeAuth:
    def __init__(self, token):
        self._token = token

    def token(self):
        return self._token


def test_auth_token_sets_authorization_header():
    route = _route(auth=_FakeAuth("auth-token-xyz"))
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(headers)
        return 200, b"ok"

    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts,
    )

    assert posts[0]["Authorization"] == "Bearer auth-token-xyz"


def test_auth_none_token_takes_no_credential_path(tmp_path):
    route = _route(auth=_FakeAuth(None))
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    events = []

    def fake_post(url, data, headers):
        events.append("post")
        return 200, b"ok"

    def fake_sleep(d):
        events.append("sleep")
        route.auth._token = "now-available"  # the credential arrives

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=fake_sleep, poll_timeout=1.0, counts=counts,
    )

    assert processed is True
    assert events == ["sleep", "post"]
    assert counts.get("no_credential") == 1
    assert counts.get("delivered") == 1
    assert consumer.committed == [message]
