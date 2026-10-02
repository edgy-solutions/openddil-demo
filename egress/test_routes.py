"""Unit tests for egress/routes.py — ADR-0043.

Run: `python -m pytest egress/test_routes.py -q` from openddil-demo/.

No Kafka: `run_once` is exercised with fake consumer and producer objects
(the same injection seam test_gate.py uses for the PDP answer), so
confluent_kafka is never imported here.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import delivery  # noqa: E402
import routes as routes_mod  # noqa: E402
from gate import ADMIT, REASON_NO_OVERLAP, EgressGate  # noqa: E402
from routes import Route, RouteError, load_routes, run_once  # noqa: E402


def _write_routes(tmp_path, entries) -> str:
    path = tmp_path / "routes.json"
    path.write_text(json.dumps(entries))
    return str(path)


# --- load_routes --------------------------------------------------------

def test_env_fallback_reproduces_todays_single_route(monkeypatch):
    monkeypatch.delenv("OPENDDIL_EGRESS_ROUTES_PATH", raising=False)
    result = load_routes(None, known_kinds=())
    assert result == [Route(
        name=None,
        source_topic=routes_mod.SOURCE_TOPIC,
        destination=routes_mod.DESTINATION,
        sink_topic=routes_mod.SINK_TOPIC,
        kind=None,
        group=None,
    )]


def test_duplicate_name_fails_naming_the_entry(tmp_path):
    path = _write_routes(tmp_path, [
        {"name": "r1", "source_topic": "t1", "destination": "system:dest-a", "sink_topic": "s1"},
        {"name": "r1", "source_topic": "t2", "destination": "system:dest-b", "sink_topic": "s2"},
    ])
    with pytest.raises(RouteError) as exc:
        load_routes(path, known_kinds=())
    assert "r1" in str(exc.value)


def test_unknown_kind_fails_naming_the_entry(tmp_path):
    path = _write_routes(tmp_path, [
        {"name": "r1", "source_topic": "t1", "destination": "system:dest-a",
         "sink_topic": "s1", "kind": "KindA"},
    ])
    with pytest.raises(RouteError) as exc:
        load_routes(path, known_kinds=())
    assert "r1" in str(exc.value)
    assert "KindA" in str(exc.value)


def test_per_route_group_fails_naming_the_entry(tmp_path):
    path = _write_routes(tmp_path, [
        {"name": "r1", "source_topic": "t1", "destination": "system:dest-a",
         "sink_topic": "s1", "group": "custom-group"},
    ])
    with pytest.raises(RouteError) as exc:
        load_routes(path, known_kinds=())
    assert "r1" in str(exc.value)
    assert "not supported in this pass" in str(exc.value)


def test_a_known_kind_loads_cleanly(tmp_path):
    path = _write_routes(tmp_path, [
        {"name": "r1", "source_topic": "t1", "destination": "system:dest-a",
         "sink_topic": "s1", "kind": "KindA"},
    ])
    loaded = load_routes(path, known_kinds=["KindA"])
    assert loaded == [Route(
        name="r1", source_topic="t1", destination="system:dest-a",
        sink_topic="s1", kind="KindA", group=None,
    )]


# --- run_once: the fan-out ------------------------------------------------

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


class _FakeProducer:
    """`produce` only queues a callback; `flush` is what actually invokes
    it — the same two-step shape `delivery.send_one` relies on against a
    real `confluent_kafka.Producer`. `fail=True` has every delivery report
    back an error, standing in for a broker that refused the write."""

    def __init__(self, *, fail=False):
        self.produced = []
        self.fail = fail
        self._pending = []

    def produce(self, topic, value=None, key=None, callback=None):
        self.produced.append((topic, value, key))
        self._pending.append((callback, topic, key))

    def poll(self, timeout):
        pass

    def flush(self, timeout):
        for callback, topic, key in self._pending:
            if callback is not None:
                callback(f"broker refused {topic}" if self.fail else None, None)
        self._pending.clear()
        return 0


def test_two_route_fan_out_decides_both_produces_only_admitted_commits_once(monkeypatch):
    route_a = Route(name="to-a", source_topic="asset-status",
                     destination="system:dest-a", sink_topic="sink-a")
    route_b = Route(name="to-b", source_topic="asset-status",
                     destination="system:dest-b", sink_topic="sink-b")

    gate_a = EgressGate("system:dest-a", ["ATL"])  # will admit
    gate_b = EgressGate("system:dest-b", ["BDR"])  # will refuse: no overlap

    record = {"asset_id": "dis:1:1:1000", "originator_nation": "ATL", "releasable_to": []}
    message = _FakeMessage("asset-status", b"k1", json.dumps(record).encode())

    consumer = _FakeConsumer([message])
    producer = _FakeProducer()

    logged = []
    monkeypatch.setattr(routes_mod.EgressGate, "log",
                         staticmethod(lambda d: logged.append(d)))

    processed = run_once(
        consumer, producer,
        routes_by_topic={"asset-status": [route_a, route_b]},
        gates={route_a: gate_a, route_b: gate_b},
        decode=lambda payload: json.loads(payload.decode()),
        poll_timeout=1.0,
    )

    assert processed is True
    assert len(logged) == 2
    assert {d.route for d in logged} == {"to-a", "to-b"}
    by_route = {d.route: d for d in logged}
    assert by_route["to-a"].allowed and by_route["to-a"].reason == ADMIT
    assert not by_route["to-b"].allowed and by_route["to-b"].reason == REASON_NO_OVERLAP

    assert producer.produced == [("sink-a", message.value(), b"k1")]
    assert consumer.committed == [message]


def test_a_failed_sink_delivery_raises_and_the_offset_is_not_committed(monkeypatch):
    route_a = Route(name="to-a", source_topic="asset-status",
                     destination="system:dest-a", sink_topic="sink-a")
    gate_a = EgressGate("system:dest-a", ["ATL"])  # will admit

    record = {"asset_id": "dis:1:1:1000", "originator_nation": "ATL", "releasable_to": []}
    message = _FakeMessage("asset-status", b"k1", json.dumps(record).encode())

    consumer = _FakeConsumer([message])
    producer = _FakeProducer(fail=True)

    logged = []
    monkeypatch.setattr(routes_mod.EgressGate, "log",
                         staticmethod(lambda d: logged.append(d)))

    with pytest.raises(delivery.DeliveryFailed):
        run_once(
            consumer, producer,
            routes_by_topic={"asset-status": [route_a]},
            gates={route_a: gate_a},
            decode=lambda payload: json.loads(payload.decode()),
            poll_timeout=1.0,
        )

    # The DECISION was logged (the decision was made) even though the sink
    # write that followed it was never confirmed delivered.
    assert len(logged) == 1
    assert logged[0].allowed and logged[0].reason == ADMIT

    assert consumer.committed == []
