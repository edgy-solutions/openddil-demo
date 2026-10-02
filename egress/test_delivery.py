"""Unit tests for egress/delivery.py — the shared produce-then-confirm
helper both assembler.py and routes.py use before advancing their own
bookkeeping or committing an input offset.

Run: `python -m pytest egress/test_delivery.py -q` from openddil-demo/.

No Kafka: a fake producer stands in for `confluent_kafka.Producer`, used
only through `.produce(topic, value=, key=, callback=)` and
`.flush(timeout)` — the two calls `delivery.send`/`send_one` actually make.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from delivery import DeliveryFailed, send, send_one  # noqa: E402


class _FakeProducer:
    """`produce` only queues a callback; `flush` is what actually invokes
    it — real `confluent_kafka.Producer` only fires delivery callbacks on a
    `.poll()`/`.flush()` call, never inside `.produce()` itself.
    `never_deliver` leaves every callback uncalled, standing in for a
    broker that never reports back inside the timeout."""

    def __init__(self, *, error=None, never_deliver=False):
        self.error = error
        self.never_deliver = never_deliver
        self.produced: list[tuple[str, bytes, bytes]] = []
        self._pending = []

    def produce(self, topic, value=None, key=None, callback=None):
        self.produced.append((topic, value, key))
        self._pending.append(callback)

    def flush(self, timeout):
        if not self.never_deliver:
            for callback in self._pending:
                if callback is not None:
                    callback(self.error, None)
            remaining = 0
        else:
            remaining = len(self._pending)
        self._pending.clear()
        return remaining


def test_all_delivered_returns_normally():
    producer = _FakeProducer(error=None)
    send_one(producer, "sink", b"v", b"k", timeout=1.0)
    assert producer.produced == [("sink", b"v", b"k")]


def test_a_failed_delivery_raises_naming_topic_key_and_error():
    producer = _FakeProducer(error="broker said no")
    with pytest.raises(DeliveryFailed) as exc:
        send_one(producer, "sink", b"v", b"k1", timeout=1.0)
    assert exc.value.topic == "sink"
    assert exc.value.key == b"k1"
    assert "broker said no" in str(exc.value)


def test_a_delivery_that_never_reports_back_raises_on_timeout():
    producer = _FakeProducer(never_deliver=True)
    with pytest.raises(DeliveryFailed) as exc:
        send_one(producer, "sink", b"v", b"k", timeout=0.01)
    assert exc.value.topic == "sink"
    assert exc.value.key == b"k"


def test_send_confirms_every_message_in_one_batch():
    producer = _FakeProducer(error=None)
    send(producer, [("a", b"1", b"k1"), ("b", b"2", b"k2")], timeout=1.0)
    assert producer.produced == [("a", b"1", b"k1"), ("b", b"2", b"k2")]


def test_send_raises_on_the_first_undelivered_message_in_a_batch():
    producer = _FakeProducer(error="nope")
    with pytest.raises(DeliveryFailed) as exc:
        send(producer, [("a", b"1", b"k1"), ("b", b"2", b"k2")], timeout=1.0)
    assert exc.value.topic == "a"
