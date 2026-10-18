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
from confluent_kafka import KafkaError, KafkaException, TopicPartition

sys.path.insert(0, str(Path(__file__).parent))

import forwarder as forwarder_mod  # noqa: E402
from forwarder import (  # noqa: E402
    Envelope,
    ForwardConfigError,
    ForwardRoute,
    build_envelope,
    load_forward_config,
    run_once,
)
from kinds import Declarations, EpisodeDecl  # noqa: E402


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
    def __init__(self, messages, assignment=None):
        self._messages = list(messages)
        self.committed = []
        self._assignment = list(assignment) if assignment is not None else [TopicPartition("sink-a", 0)]
        self.events = []  # ordered ("poll"|"pause"|"resume"|"seek"|"commit", detail)
        self.poll_hook = None  # called with the consumer on every poll after the first
        self.commit_error = None
        self._polls = 0

    def assignment(self):
        return list(self._assignment)

    def pause(self, partitions):
        self.events.append(("pause", [(p.topic, p.partition) for p in partitions]))

    def resume(self, partitions):
        self.events.append(("resume", [(p.topic, p.partition) for p in partitions]))

    def seek(self, tp):
        self.events.append(("seek", (tp.topic, tp.partition, tp.offset)))

    def poll(self, timeout):
        self._polls += 1
        self.events.append(("poll", timeout))
        if self._polls > 1 and self.poll_hook is not None:
            self.poll_hook(self)
        if not self._messages:
            return None
        return self._messages.pop(0)

    def commit(self, msg, asynchronous=False):
        self.events.append(("commit", None))
        if self.commit_error is not None:
            raise self.commit_error
        self.committed.append(msg)

    def kinds(self):
        return [k for k, _ in self.events]


class _Clock:
    """A fake clock: `sleep` is the only thing that advances it."""

    def __init__(self):
        self.t = 1000.0
        self.slept = 0.0

    def now(self):
        return self.t

    def sleep(self, d):
        self.t += d
        self.slept += d


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
        self.failed_calls = 0
        self.failed_failures = 0

    def lookup(self, route, event_id):
        self.lookup_calls += 1
        if self.lookup_failures > 0:
            self.lookup_failures -= 1
            raise RuntimeError("store unavailable")
        return self._rows.get((route, event_id))

    def upsert_held(self, *, route, event_id, topic, partition, offset, stamps=None):
        self.upsert_calls += 1
        if self.upsert_failures > 0:
            self.upsert_failures -= 1
            raise RuntimeError("store unavailable")
        self._rows[(route, event_id)] = {"outcome": "held", "case_id": None, **(stamps or {})}

    def upsert_failed(self, *, route, event_id, topic, partition, offset, stamps=None):
        self.failed_calls += 1
        if self.failed_failures > 0:
            self.failed_failures -= 1
            raise RuntimeError("store unavailable")
        self._rows[(route, event_id)] = {"outcome": "failed", "case_id": None, **(stamps or {})}

    def upsert_delivered(self, *, route, event_id, http_status, case_id, topic, partition, offset, stamps=None):
        self.upsert_calls += 1
        if self.upsert_failures > 0:
            self.upsert_failures -= 1
            raise RuntimeError("store unavailable")
        self._rows[(route, event_id)] = {"outcome": "delivered", "case_id": case_id, **(stamps or {})}


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

    def fake_log_outcome(name, key, kind, status, outcome, *, case_id=None, **_kw):
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


# --- episode stamps (episode_id / asset_id / component / fault_code) -------

_STAMP_DECL = Declarations(
    key="/event_id", label="/label",
    episode=EpisodeDecl(asset="/subject", component="/what/part", fault_code="/what/code"),
    episode_id="/episode_id",
)


def _deliver_one(route, record, declarations, store):
    consumer = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps(record).encode())])
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda url, data, headers: (200, json.dumps({"case_id": "case-1"}).encode()),
        sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, store=store, log_outcome=lambda *a, **k: None,
        declarations=declarations,
    )
    return counts


def test_delivered_fault_event_stamps_all_four_columns():
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    record = {"event_id": "ev-1", "episode_id": "ep-1", "subject": "asset-a",
              "what": {"part": "comp-1", "code": "F-1"}}
    counts = _deliver_one(route, record, {"KindA": _STAMP_DECL}, store)
    assert counts.get("delivered") == 1
    row = store._rows[("to-a", "ev-1")]
    assert row["case_id"] == "case-1"
    assert (row["episode_id"], row["asset_id"], row["component"], row["fault_code"]) == (
        "ep-1", "asset-a", "comp-1", "F-1")


def test_kind_without_episode_block_stamps_nulls_and_still_delivers():
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    record = {"event_id": "ev-2", "subject": "asset-a"}
    bare = Declarations(key="/event_id", label="/label")
    for decls in ({"KindA": bare}, {}, None):
        store._rows.clear()
        counts = _deliver_one(route, record, decls, store)
        assert counts.get("delivered") == 1
        row = store._rows[("to-a", "ev-2")]
        assert row["outcome"] == "delivered"
        assert (row["episode_id"], row["asset_id"], row["component"], row["fault_code"]) == (None,) * 4


def test_unresolved_pointer_stamps_null_for_that_column_only():
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    record = {"event_id": "ev-3", "subject": "asset-a", "what": {"part": "comp-1"}}
    _deliver_one(route, record, {"KindA": _STAMP_DECL}, store)
    row = store._rows[("to-a", "ev-3")]
    assert (row["episode_id"], row["asset_id"], row["component"], row["fault_code"]) == (
        None, "asset-a", "comp-1", None)


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
        # A frozen clock: each poll takes no time, so every 1 s slice is slept
        # in full. On the real clock the slices come up microseconds short.
        clock=lambda: 0.0,
    )

    assert processed is True
    assert len(posts) == 1
    assert sum(slept) == pytest.approx(3.0)  # backoff 1 s then 2 s, slept in 1 s slices
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
        # A frozen clock: each poll takes no time, so every 1 s slice is slept
        # in full. On the real clock the slices come up microseconds short.
        clock=lambda: 0.0,
    )

    assert processed is True
    assert len(posts) == 1
    assert sum(slept) == pytest.approx(3.0)  # backoff 1 s then 2 s, slept in 1 s slices
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

    def fake_log_outcome(name, key, kind, status, outcome, *, case_id=None, **_kw):
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


# --- F-a: case_id from the 200 body -----------------------------------------

def _case_id_run(body: bytes, event_id="E1"):
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    consumer = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps({"event_id": event_id}).encode())])
    logged = []

    def fake_log_outcome(name, key, kind, status, outcome, **kw):
        logged.append((outcome, kw))

    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: (200, body), sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, store=store, log_outcome=fake_log_outcome,
    )
    delivered = [kw for outcome, kw in logged if outcome == "delivered"]
    assert len(delivered) == 1
    return delivered[0], counts, store


def test_case_id_read_from_workflow_object_matches_event_id():
    kw, counts, store = _case_id_run(b'{"workflow":{"case_id":"E1"}}')
    assert kw["case_id"] == "E1"
    assert "case_id_mismatch" not in kw
    assert counts.get("case_id_mismatch") is None
    assert counts.get("case_id_missing") is None
    assert store._rows[("to-a", "E1")]["case_id"] == "E1"


def test_case_id_differing_from_event_id_is_counted_and_flagged_but_delivered():
    kw, counts, store = _case_id_run(b'{"workflow":{"case_id":"X"}}')
    assert kw["case_id"] == "X"
    assert kw["case_id_mismatch"] is True
    assert counts["case_id_mismatch"] == 1
    assert counts["delivered"] == 1
    assert store._rows[("to-a", "E1")] == {
        "outcome": "delivered", "case_id": "X",
        "episode_id": None, "asset_id": None, "component": None, "fault_code": None}


def test_case_id_top_level_fallback():
    kw, counts, _ = _case_id_run(b'{"case_id":"E1"}')
    assert kw["case_id"] == "E1"
    assert counts.get("case_id_mismatch") is None


def test_case_id_workflow_wins_over_top_level():
    kw, _, _ = _case_id_run(b'{"case_id":"top","workflow":{"case_id":"E1"}}')
    assert kw["case_id"] == "E1"


def test_case_id_absent_is_null_and_counted_missing():
    kw, counts, _ = _case_id_run(b"{}")
    assert kw["case_id"] is None
    assert counts["case_id_missing"] == 1
    assert counts.get("case_id_mismatch") is None


# --- F-b: waiting keeps the membership alive --------------------------------

def _plain_msg(topic="sink-a", partition=0, offset=0, record=None):
    return _FakeMessage(topic, b"k1", json.dumps(record or {"a": 1}).encode(), partition=partition, offset=offset)


def test_u1_retry_waits_poll_paused_and_resume_before_commit():
    route = _route()
    message = _plain_msg()
    consumer = _FakeConsumer([message])
    clock = _Clock()
    statuses = iter([503, 503, 200])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return next(statuses), b""

    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode, post=fake_post,
        sleep=clock.sleep, clock=clock.now, poll_timeout=1.0, counts=counts,
    )

    assert len(posts) == 3
    assert consumer.committed == [message]
    kinds = consumer.kinds()
    assert kinds.count("commit") == 1
    assert ("pause", [("sink-a", 0)]) in consumer.events
    # backoff was 1 s then 2 s: at least one wait poll per simulated second
    wait_polls = [d for k, d in consumer.events[1:] if k == "poll"]
    assert len(wait_polls) >= 3
    assert all(0 < d <= 1.0 for d in wait_polls)
    assert clock.slept >= 3.0
    assert kinds.index("pause") < kinds.index("commit")
    assert max(i for i, k in enumerate(kinds) if k == "resume") < kinds.index("commit")
    # every pause is matched by a resume of the same partitions
    assert kinds.count("pause") == kinds.count("resume")


def test_u2_commit_failure_unknown_member_is_not_fatal():
    route = _route()
    consumer = _FakeConsumer([_plain_msg()])
    consumer.commit_error = KafkaException(KafkaError(KafkaError.UNKNOWN_MEMBER_ID))
    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: (200, b"{}"), sleep=lambda d: pytest.fail("no retry"),
        poll_timeout=1.0, counts=counts,
    )
    assert processed is True
    assert counts["delivered"] == 1
    assert counts["commit_failed"] == 1


def test_u2b_other_commit_errors_still_raise():
    route = _route()
    consumer = _FakeConsumer([_plain_msg()])
    consumer.commit_error = KafkaException(KafkaError(KafkaError._FATAL))
    with pytest.raises(KafkaException):
        run_once(
            consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
            post=lambda u, d, h: (200, b"{}"), sleep=lambda d: pytest.fail("no retry"),
            poll_timeout=1.0, counts={},
        )


def test_u3_message_polled_during_wait_is_seeked_back_and_not_delivered():
    route = _route()
    first = _plain_msg(partition=0, offset=5)
    other = _plain_msg(partition=1, offset=42)
    consumer = _FakeConsumer([first, other])
    clock = _Clock()
    statuses = iter([503, 200])
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return next(statuses), b""

    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode, post=fake_post,
        sleep=clock.sleep, clock=clock.now, poll_timeout=1.0, counts=counts,
    )
    assert ("seek", ("sink-a", 1, 42)) in consumer.events
    assert ("pause", [("sink-a", 1)]) in consumer.events
    assert len(posts) == 2  # the first record only
    assert consumer.committed == [first]  # the other was neither delivered nor committed
    assert counts["delivered"] == 1


def test_u4_revoke_during_wait_abandons_without_commit_or_further_post():
    route = _route()
    message = _plain_msg()
    consumer = _FakeConsumer([message])
    flight = forwarder_mod.InFlight()
    consumer.poll_hook = lambda c: flight.on_revoke(c, [TopicPartition("sink-a", 0)])
    clock = _Clock()
    posts = []

    def fake_post(url, data, headers):
        posts.append(1)
        return 503, b""

    counts: dict[str, int] = {}
    processed = run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode, post=fake_post,
        sleep=clock.sleep, clock=clock.now, poll_timeout=1.0, counts=counts, flight=flight,
    )
    assert processed is True
    assert counts["abandoned"] == 1
    assert counts.get("delivered") is None
    assert consumer.committed == []
    assert "commit" not in consumer.kinds()
    assert len(posts) == 1


def test_u4b_revoke_of_another_partition_does_not_abandon():
    route = _route()
    message = _plain_msg()
    consumer = _FakeConsumer([message])
    flight = forwarder_mod.InFlight()
    consumer.poll_hook = lambda c: flight.on_revoke(c, [TopicPartition("sink-a", 7)])
    clock = _Clock()
    statuses = iter([503, 200])
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: (next(statuses), b""), sleep=clock.sleep, clock=clock.now,
        poll_timeout=1.0, counts=counts, flight=flight,
    )
    assert counts.get("abandoned") is None
    assert consumer.committed == [message]


def test_u5_retry_budget_exhausted_holds_and_commits():
    route = _route(dedupe_field="event_id", token_file="/nonexistent/token")
    store = _FakeStore()
    message = _plain_msg(record={"event_id": "E9"})
    consumer = _FakeConsumer([message])
    clock = _Clock()
    posts = []
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: posts.append(1) or (200, b"{}"),
        sleep=clock.sleep, clock=clock.now, poll_timeout=1.0, counts=counts,
        store=store, read_token=lambda p: None, retry_max_s=10.0,
    )
    assert posts == []
    assert counts["exhausted"] == 1
    assert clock.slept > 10.0
    assert clock.slept < 10.0 + 60.0
    assert store.upsert_calls == 1
    assert store._rows[("to-a", "E9")]["outcome"] == "held"
    assert consumer.committed == [message]
    assert consumer.kinds().count("commit") == 1


def _run_exhausted(store, *, retry_max_s=10.0, post=None):
    route = _route(dedupe_field="event_id", token_file="/nonexistent/token")
    message = _plain_msg(record={"event_id": "E9"})
    consumer = _FakeConsumer([message])
    clock = _Clock()
    counts: dict[str, int] = {}
    logged = []
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=post or (lambda u, d, h: (200, b"{}")),
        sleep=clock.sleep, clock=clock.now, poll_timeout=1.0, counts=counts,
        store=store, read_token=lambda p: None, retry_max_s=retry_max_s,
        log_outcome=lambda name, key, kind, status, outcome, **_kw: logged.append(outcome),
    )
    return consumer, message, counts, logged


def test_f1_exhausted_and_held_write_fails_records_failed():
    store = _FakeStore()
    store.upsert_failures = 1
    consumer, message, counts, logged = _run_exhausted(store)
    assert store.failed_calls == 1
    assert store._rows[("to-a", "E9")]["outcome"] == "failed"
    assert counts["failed_recorded"] == 1
    assert counts.get("undelivered_declared") is None
    assert "failed" in logged
    assert consumer.committed == [message]
    assert consumer.kinds().count("commit") == 1


def test_f2_exhausted_and_both_writes_fail_declares_undelivered(caplog):
    store = _FakeStore()
    store.upsert_failures = 1
    store.failed_failures = 1
    with caplog.at_level("ERROR"):
        consumer, message, counts, _logged = _run_exhausted(store)
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("declared-undelivered")]
    assert len(lines) == 1
    for part in ("route=to-a", "event_id=E9", "topic=", "partition=", "offset=", "store unavailable"):
        assert part in lines[0]
    assert counts["undelivered_declared"] == 1
    assert counts.get("failed_recorded") is None
    assert store._rows == {}
    assert consumer.committed == [message]
    assert consumer.kinds().count("commit") == 1


def test_f3_held_write_ok_records_held_and_never_failed():
    store = _FakeStore()
    consumer, message, counts, _logged = _run_exhausted(store)
    assert store._rows[("to-a", "E9")]["outcome"] == "held"
    assert store.failed_calls == 0
    assert counts.get("failed_recorded") is None
    assert consumer.committed == [message]


def test_f4_stored_failed_row_does_not_block_a_later_send():
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    store._rows[("to-a", "E9")] = {"outcome": "failed", "case_id": None}
    message = _plain_msg(record={"event_id": "E9"})
    consumer = _FakeConsumer([message])
    posts = []
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: posts.append(1) or (200, b"{}"),
        sleep=lambda d: pytest.fail("no retry expected"), poll_timeout=1.0, counts=counts, store=store,
    )
    assert posts == [1]
    assert counts.get("duplicate") is None
    assert counts["delivered"] == 1
    assert store._rows[("to-a", "E9")]["outcome"] == "delivered"


# --- operator re-send ---------------------------------------------------------

class _ResendRig:
    """The fakes `resend_once` takes, sharing one call-order list."""

    def __init__(self, *, status=200, body=None, post_exc=None, row="default",
                 record_exc=None, audit_fail_on=()):
        self.events: list[tuple] = []
        self.status = status
        self.body = json.dumps({"case_id": "c-9"}).encode() if body is None else body
        self.post_exc = post_exc
        self.record_exc = record_exc
        self.audit_fail_on = set(audit_fail_on)
        self.audits: list[dict] = []
        self.posts: list[tuple] = []
        self.records: list[tuple] = []
        self.row = {"outcome": "delivered", "case_id": "c-1"} if row == "default" else row
        rig = self

        class Store:
            def lookup(self, route, event_id):
                return rig.row

            def record_resend(self, route, event_id, http_status, case_id, stamps=None):
                rig.events.append(("record_resend",))
                rig.records.append((route, event_id, http_status, case_id))
                if rig.record_exc:
                    raise rig.record_exc

        self.store = Store()

    def post(self, url, data, headers):
        self.events.append(("post",))
        self.posts.append((url, data, dict(headers)))
        if self.post_exc:
            raise self.post_exc
        return self.status, self.body

    def audit(self, payload):
        n = len(self.audits) + 1
        self.audits.append(dict(payload))
        self.events.append(("audit", payload["outcome"]))
        if n in self.audit_fail_on:
            raise OSError("log not writable")

    def run(self, routes=None, **over):
        assert hasattr(forwarder_mod, "resend_once"), "resend_once is not defined"
        kw = dict(route_name="to-a", event_id="ev-1", reason="destination lost it", key="k1",
                  record={"event_id": "ev-1", "a": 1}, post=self.post, store=self.store,
                  read_token=lambda _p: "tok", audit=self.audit)
        kw.update(over)
        routes = routes if routes is not None else {"to-a": _route(dedupe_field="event_id")}
        return forwarder_mod.resend_once(routes, **kw)

    def assert_refused(self, code, refusal):
        assert code == 2
        assert self.posts == [] and self.records == []
        assert self.audits[-1]["outcome"] == "operator_resend_refused"
        assert self.audits[-1]["refusal"] == refusal


def test_resend_2xx_posts_once_records_and_logs_before_sending():
    rig = _ResendRig()
    route = _route(dedupe_field="event_id", token_file="/tok")
    code = rig.run({"to-a": route})
    assert code == 0
    assert len(rig.posts) == 1
    url, data, headers = rig.posts[0]
    assert url == route.url
    assert json.loads(data) == build_envelope(route, "k1", {"event_id": "ev-1", "a": 1})
    assert headers["Authorization"] == "Bearer tok"
    assert rig.records == [("to-a", "ev-1", 200, "c-9")]
    assert [a["outcome"] for a in rig.audits] == ["operator_resend_requested", "operator_resend"]
    assert rig.audits[1]["case_id"] == "c-9"
    assert rig.audits[1]["prior_outcome"] == "delivered" and rig.audits[1]["prior_case_id"] == "c-1"
    assert rig.audits[1]["case_id_mismatch"] is True
    assert rig.events == [("audit", "operator_resend_requested"), ("post",),
                          ("record_resend",), ("audit", "operator_resend")]
    assert "tok" not in json.dumps(rig.audits)


def test_resend_refusal_1_route_not_in_config():
    rig = _ResendRig()
    rig.assert_refused(rig.run(route_name="nope"), "route_not_in_config")


def test_resend_refusal_2_route_has_no_dedupe_field():
    rig = _ResendRig()
    rig.assert_refused(rig.run({"to-a": _route()}), "route_has_no_dedupe_field")


def test_resend_refusal_3_route_is_held():
    rig = _ResendRig()
    rig.assert_refused(rig.run({"to-a": _route(dedupe_field="event_id", held=True)}), "route_is_held")


@pytest.mark.parametrize("record", [[1, 2], "text", None, {"event_id": "other"}, {"a": 1}])
def test_resend_refusal_4_record_not_object_or_event_id_mismatch(record):
    rig = _ResendRig()
    rig.assert_refused(rig.run(record=record), "record_not_an_object_or_event_id_mismatch")


@pytest.mark.parametrize("reason", ["", "   \n"])
def test_resend_refusal_5_reason_empty(reason):
    rig = _ResendRig()
    rig.assert_refused(rig.run(reason=reason), "reason_empty")


def test_resend_refusal_6_no_ledger_row():
    rig = _ResendRig(row=None)
    rig.assert_refused(rig.run(), "no_ledger_row")


def test_resend_refusal_7_requested_line_unwritable_means_no_send():
    rig = _ResendRig(audit_fail_on=(1,))
    code = rig.run()
    assert code == 2
    assert rig.posts == [] and rig.records == []
    assert rig.audits[-1]["outcome"] == "operator_resend_refused"
    assert rig.audits[-1]["refusal"] == "audit_unwritable"


def test_resend_refusal_line_unwritable_prints_to_stderr(capsys):
    rig = _ResendRig(row=None, audit_fail_on=(1,))
    assert rig.run() == 2
    assert "no_ledger_row" in capsys.readouterr().err


def test_resend_5xx_one_post_no_ledger_write():
    rig = _ResendRig(status=503, body=b"")
    assert rig.run() == 1
    assert len(rig.posts) == 1 and rig.records == []
    assert rig.audits[-1]["outcome"] == "operator_resend_failed"
    assert rig.audits[-1]["status"] == 503


def test_resend_oserror_one_post_status_null():
    rig = _ResendRig(post_exc=OSError("refused"))
    assert rig.run() == 1
    assert len(rig.posts) == 1 and rig.records == []
    assert rig.audits[-1]["outcome"] == "operator_resend_failed"
    assert rig.audits[-1]["status"] is None


def test_resend_2xx_store_raises_is_unrecorded_exit_3():
    rig = _ResendRig(record_exc=RuntimeError("db down"))
    assert rig.run() == 3
    assert len(rig.posts) == 1
    assert rig.audits[-1]["outcome"] == "operator_resend_unrecorded"
    assert rig.audits[-1]["status"] == 200


def test_resend_result_line_unwritable_keeps_send_exit_code(capsys):
    rig = _ResendRig(audit_fail_on=(2,))
    assert rig.run() == 0
    assert "ERROR" in capsys.readouterr().err


def test_resend_held_row_is_resent_too():
    rig = _ResendRig(row={"outcome": "held", "case_id": None})
    assert rig.run() == 0
    assert rig.audits[-1]["prior_outcome"] == "held"


def test_resend_does_not_change_the_consumer_duplicate_short_circuit():
    route = _route(dedupe_field="event_id")
    store = _FakeStore()
    store._rows[("to-a", "ev-1")] = {"outcome": "delivered", "case_id": "c-1"}
    consumer = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps({"event_id": "ev-1"}).encode())])
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda *a: pytest.fail("no POST expected"), sleep=lambda d: pytest.fail("no retry"),
        poll_timeout=1.0, counts=counts, store=store,
    )
    assert counts.get("duplicate") == 1


class _StubConn:
    def __init__(self, result):
        self.result = result
        self.calls: list[tuple] = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return self.result


def _store_with(conn):
    store = forwarder_mod.DeliveredStore("postgres://unused")
    store._conn = conn
    return store


def test_record_resend_is_an_update_never_an_insert():
    conn = _StubConn("UPDATE 1")
    _store_with(conn).record_resend("to-a", "ev-1", 200, "c-9")
    [(sql, args)] = conn.calls
    assert sql.lstrip().upper().startswith("UPDATE")
    assert "INSERT" not in sql.upper()
    assert "first_recorded_at" not in sql and "kafka_offset" not in sql
    assert args == ("to-a", "ev-1", 200, "c-9", None, None, None, None)


def test_record_resend_zero_rows_raises():
    with pytest.raises(RuntimeError):
        _store_with(_StubConn("UPDATE 0")).record_resend("to-a", "ev-1", 200, None)


# --- case_field: the expected case id is the episode's, not the event's -----

def _case_field_run(body: bytes):
    route = _route(dedupe_field="event_id", case_field="episode_id")
    store = _FakeStore()
    record = {"event_id": "E2", "episode_id": "EP1"}
    consumer = _FakeConsumer([_FakeMessage("sink-a", b"k1", json.dumps(record).encode())])
    counts: dict[str, int] = {}
    run_once(
        consumer, routes_by_topic={"sink-a": [route]}, decode=_decode,
        post=lambda u, d, h: (200, body), sleep=lambda d: pytest.fail("no retry expected"),
        poll_timeout=1.0, counts=counts, store=store, log_outcome=lambda *a, **k: None,
    )
    return counts, store


def test_case_field_expects_the_episode_id_and_a_match_is_clean():
    counts, store = _case_field_run(b'{"workflow":{"case_id":"EP1"}}')
    assert counts["delivered"] == 1
    assert counts.get("case_id_mismatch") is None
    assert store._rows[("to-a", "E2")]["case_id"] == "EP1"


def test_case_field_returning_the_event_id_is_a_counted_mismatch_but_delivered():
    counts, store = _case_field_run(b'{"workflow":{"case_id":"E2"}}')
    assert counts["delivered"] == 1
    assert counts["case_id_mismatch"] == 1
    assert store._rows[("to-a", "E2")]["case_id"] == "E2"


def test_resend_with_case_field_compares_against_the_episode_id():
    rig = _ResendRig(body=json.dumps({"workflow": {"case_id": "EP1"}}).encode())
    route = _route(dedupe_field="event_id", case_field="episode_id")
    rec = {"event_id": "ev-1", "episode_id": "EP1"}
    assert rig.run({"to-a": route}, record=rec) == 0
    assert "case_id_mismatch" not in rig.audits[1]

    rig = _ResendRig(body=json.dumps({"workflow": {"case_id": "ev-1"}}).encode())
    assert rig.run({"to-a": route}, record=rec) == 0
    assert rig.audits[1]["case_id_mismatch"] is True


@pytest.mark.parametrize("bad", ["", 5])
def test_config_refuses_a_bad_case_field(tmp_path, bad):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest",
         "kind": "KindA", "dedupe_field": "event_id", "case_field": bad},
    ])
    with pytest.raises(ForwardConfigError) as exc:
        load_forward_config(path)
    assert "case_field" in str(exc.value)


def test_config_accepts_case_field(tmp_path):
    path = _write_config(tmp_path, [
        {"name": "f1", "sink_topic": "sink-a", "url": "http://sink.invalid/ingest",
         "kind": "KindA", "dedupe_field": "event_id", "case_field": "episode_id"},
    ])
    [route] = load_forward_config(path)
    assert route.case_field == "episode_id"


def test_upsert_never_overwrites_a_stored_stamp_with_null():
    conn = _StubConn("INSERT 0 1")
    store = _store_with(conn)
    store.upsert_delivered(
        route="to-a", event_id="ev-1", http_status=200, case_id="case-1", topic="t", partition=0, offset=1,
        stamps={"episode_id": "ep-1", "asset_id": None, "component": None, "fault_code": None})
    [(sql, args)] = conn.calls
    for col in ("episode_id", "asset_id", "component", "fault_code"):
        assert f'"{col}" = COALESCE(excluded."{col}"' in sql
    assert args[-4:] == ("ep-1", None, None, None)

    conn2 = _StubConn("UPDATE 1")
    _store_with(conn2).record_resend("to-a", "ev-1", 200, "case-1", stamps={"asset_id": "asset-a"})
    [(sql2, args2)] = conn2.calls
    assert 'COALESCE($6, "asset_id")' in sql2
    assert args2[-4:] == (None, "asset-a", None, None)
