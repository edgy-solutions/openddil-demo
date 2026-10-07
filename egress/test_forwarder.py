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


# --- envelope.static ---------------------------------------------------------

def test_static_fields_appear_in_posted_body(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"static": {"source": "demo-edge", "schema_version": 2, "retry": False}}},
    ])
    [route] = load_forward_config(path)
    assert dict(route.envelope.static) == {"source": "demo-edge", "schema_version": 2, "retry": False}

    env = build_envelope(route, "k1", {"a": 1})
    assert env == {
        "source": "demo-edge", "schema_version": 2, "retry": False,
        "kind": "KindA", "id": "k1", "payload": {"a": 1},
    }


def test_default_envelope_has_no_static_fields(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA"},
    ])
    [route] = load_forward_config(path)
    assert dict(route.envelope.static) == {}

    env = build_envelope(route, "k1", {"a": 1})
    assert json.dumps(env, separators=(",", ":")) == '{"kind":"KindA","id":"k1","payload":{"a":1}}'


def test_static_colliding_with_body_field_raises_naming_the_key(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"static": {"payload": "oops"}}},
    ])
    with pytest.raises(ForwardConfigError) as exc:
        load_forward_config(path)
    assert "payload" in str(exc.value)


def test_static_colliding_with_kind_field_raises_naming_the_key(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"kind_field": "type", "static": {"type": "oops"}}},
    ])
    with pytest.raises(ForwardConfigError) as exc:
        load_forward_config(path)
    assert "type" in str(exc.value)


def test_static_non_object_raises_forward_config_error(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"static": ["not", "an", "object"]}},
    ])
    with pytest.raises(ForwardConfigError):
        load_forward_config(path)


def test_static_nested_value_raises_forward_config_error(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest", "kind": "KindA",
         "envelope": {"static": {"nested": {"a": 1}}}},
    ])
    with pytest.raises(ForwardConfigError):
        load_forward_config(path)


# --- run_once: the fake consumer/HTTP seam ---------------------------------

class _FakeMessage:
    def __init__(self, topic, key, value, *, partition=0, offset=0):
        self._topic, self._key, self._value = topic, key, value
        self._partition, self._offset = partition, offset

    def topic(self):
        return self._topic

    def key(self):
        return self._key

    def value(self):
        return self._value

    def partition(self):
        return self._partition

    def offset(self):
        return self._offset

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


# --- dedupe / held / case_id (egress_delivered_events) ---------------------

class _FakeStore:
    """An in-memory stand-in for `forwarder.DeliveredStore`, keyed the same
    way the real table is: (route, event_id). `lookup_failures` /
    `upsert_failures` make the next N calls of the matching kind raise, to
    simulate the store being briefly unreachable."""

    def __init__(self):
        self._rows: dict[tuple[str, str], dict] = {}
        self.lookup_calls = 0
        self.upsert_calls = 0
        self.lookup_failures = 0
        self.upsert_failures = 0

    def lookup(self, route, event_id):
        self.lookup_calls += 1
        if self.lookup_failures > 0:
            self.lookup_failures -= 1
            raise RuntimeError("store unavailable")
        return self._rows.get((route, event_id))

    def upsert_held(self, *, route, event_id, topic, partition, offset):
        self.upsert_calls += 1
        if self.upsert_failures > 0:
            self.upsert_failures -= 1
            raise RuntimeError("store unavailable")
        self._rows[(route, event_id)] = {"outcome": "held", "case_id": None}

    def upsert_delivered(self, *, route, event_id, http_status, case_id, topic, partition, offset):
        self.upsert_calls += 1
        if self.upsert_failures > 0:
            self.upsert_failures -= 1
            raise RuntimeError("store unavailable")
        self._rows[(route, event_id)] = {"outcome": "delivered", "case_id": case_id}


def test_dedupe_second_send_is_duplicate_with_stored_case_id():
    """Case 1: same record twice on a dedupe route -> one POST; the second
    is `duplicate` with the first's case_id; one row."""
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    record = {"event_id": "ev-1", "a": 1}
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 200, json.dumps({"case_id": "c-1"}).encode()

    logged = []

    def fake_log_outcome(name, key, kind, status, outcome, *, case_id=None):
        logged.append((outcome, case_id))

    counts: dict[str, int] = {}
    for _ in range(2):
        consumer = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps(record).encode())])
        run_once(
            consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
            post=fake_post, sleep=lambda d: pytest.fail("no retry expected"),
            poll_timeout=1.0, counts=counts, store=store, log_outcome=fake_log_outcome,
        )

    assert len(posts) == 1
    assert counts.get("delivered") == 1
    assert counts.get("duplicate") == 1
    assert ("duplicate", "c-1") in logged
    assert len(store._rows) == 1


def test_held_route_zero_posts_held_row_committed():
    """Case 2: held route -> zero POSTs, outcome held, 'held' row; the
    message is committed."""
    route = _route(held=True, dedupe_field="event_id")
    store = _FakeStore()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"event_id": "ev-2"}).encode())
    consumer = _FakeConsumer([message])
    counts: dict[str, int] = {}

    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda *a: pytest.fail("held must not post"),
        sleep=lambda d: pytest.fail("held must not sleep"),
        poll_timeout=1.0, counts=counts, store=store,
    )

    assert processed is True
    assert counts.get("held") == 1
    assert consumer.committed == [message]
    assert store._rows[("to-a", "ev-2")]["outcome"] == "held"


def test_held_row_then_unheld_sends_once_and_becomes_delivered():
    """Case 3: held row then the route un-held (new config) -> the next
    emission is sent once and the row becomes delivered."""
    store = _FakeStore()
    record = {"event_id": "ev-3"}
    held_route = _route(held=True, dedupe_field="event_id")

    consumer1 = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps(record).encode())])
    counts: dict[str, int] = {}
    run_once(
        consumer1, routes_by_topic={"sink-a": [held_route]}, decode=_decode,
        post=lambda *a: pytest.fail("held must not post"),
        sleep=lambda d: pytest.fail("held must not sleep"),
        poll_timeout=1.0, counts=counts, store=store,
    )
    assert store._rows[("to-a", "ev-3")]["outcome"] == "held"

    unheld_route = _route(held=False, dedupe_field="event_id")
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 200, b"{}"

    consumer2 = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps(record).encode())])
    run_once(
        consumer2, routes_by_topic={"sink-a": [unheld_route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, store=store,
    )

    assert len(posts) == 1
    assert counts.get("delivered") == 1
    assert store._rows[("to-a", "ev-3")]["outcome"] == "delivered"


def test_store_down_on_lookup_zero_posts_until_it_returns():
    """Case 4: store down on lookup -> zero POSTs until the store returns,
    then exactly one."""
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    store.lookup_failures = 2
    message = _FakeMessage("sink-a", b"k1", json.dumps({"event_id": "ev-4"}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 200, b"{}"

    slept = []

    def fake_sleep(d):
        slept.append(d)
        assert posts == []

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=fake_sleep, poll_timeout=1.0, counts=counts, store=store,
    )

    assert processed is True
    assert len(posts) == 1
    assert len(slept) == 2
    assert counts.get("store_unavailable") == 2
    assert counts.get("delivered") == 1
    assert consumer.committed == [message]


def test_2xx_then_write_fails_twice_exactly_one_post():
    """Case 5: 2xx then the row write fails twice -> exactly one POST; the
    write retried until it lands."""
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    store.upsert_failures = 2
    message = _FakeMessage("sink-a", b"k1", json.dumps({"event_id": "ev-5"}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 200, b"{}"

    slept = []

    def fake_sleep(d):
        slept.append(d)

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=fake_sleep, poll_timeout=1.0, counts=counts, store=store,
    )

    assert processed is True
    assert len(posts) == 1
    assert len(slept) == 2
    assert counts.get("store_unavailable") == 2
    assert counts.get("delivered") == 1
    assert store._rows[("to-a", "ev-5")]["outcome"] == "delivered"


def test_missing_event_id_zero_posts_no_event_id():
    """Case 6: record missing event_id on a dedupe route -> zero POSTs,
    no_event_id."""
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    counts: dict[str, int] = {}

    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda *a: pytest.fail("no_event_id must not post"),
        sleep=lambda d: pytest.fail("no_event_id must not sleep"),
        poll_timeout=1.0, counts=counts, store=store,
    )

    assert processed is True
    assert counts.get("no_event_id") == 1
    assert store.lookup_calls == 0
    assert consumer.committed == [message]


def test_delivered_case_id_from_body_and_null_when_not_json():
    """Case 7: 200 body {"case_id": "c-1"} -> delivered line carries
    case_id "c-1"; a non-JSON body -> case_id null, still delivered. No
    dedupe_field here: case_id applies "on every route"."""
    route = _route()
    logged = []

    def fake_log_outcome(name, key, kind, status, outcome, *, case_id=None):
        logged.append((outcome, case_id))

    def fake_post_with_case_id(url, data, headers):
        return 200, json.dumps({"case_id": "c-1"}).encode()

    consumer1 = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())])
    counts: dict[str, int] = {}
    run_once(
        consumer1, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post_with_case_id, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, log_outcome=fake_log_outcome,
    )
    assert logged[-1] == ("delivered", "c-1")

    def fake_post_non_json(url, data, headers):
        return 200, b"not-json"

    consumer2 = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())])
    run_once(
        consumer2, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post_non_json, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, log_outcome=fake_log_outcome,
    )
    assert logged[-1] == ("delivered", None)
    assert counts.get("delivered") == 2


def test_route_without_dedupe_field_store_never_called():
    """Case 8: route without dedupe_field -> unchanged behaviour, store
    never called."""
    route = _route()
    store = _FakeStore()
    message = _FakeMessage("sink-a", b"k1", json.dumps({"a": 1}).encode())
    consumer = _FakeConsumer([message])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 200, b"ok"

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=fake_post, sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, store=store,
    )

    assert processed is True
    assert len(posts) == 1
    assert counts.get("delivered") == 1
    assert store.lookup_calls == 0
    assert store.upsert_calls == 0
    assert consumer.committed == [message]
