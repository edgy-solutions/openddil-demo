"""delivery.py — one shared helper: produce, then confirm, before the
caller treats a message as sent (ADR-0043 follow-up).

`producer.produce()` only QUEUES a message with librdkafka; it does not
mean the broker has it. Both `assembler.py` (its per-episode `produce`) and
`routes.py` (`run_once`'s per-route sink write) were treating a bare
`produce()` + `poll(0)` as success and advancing their own bookkeeping —
the assembler's `last_produced`/counters, the gate's committed input
offset — before any delivery report came back. A produce that silently
failed (the output topic not created yet, a broker hiccup) then looked
identical to one that succeeded: the counters advanced, the de-dup key
said "already produced", and the input offset moved past the message —
which is gone for good.

This module is the one place that waits for the real answer: a delivery
callback per message, then `producer.flush(timeout)` to pump them. Returns
normally only when every message was confirmed delivered; otherwise raises
`DeliveryFailed`, naming the message that was not, so a caller that has not
yet touched its own bookkeeping can simply not touch it.
"""
from __future__ import annotations

import os
from typing import Sequence

DEFAULT_TIMEOUT_S = float(os.getenv("OPENDDIL_EGRESS_DELIVERY_TIMEOUT_S", "10"))


class DeliveryFailed(RuntimeError):
    """A produced message was not confirmed delivered — the broker's
    delivery callback reported an error, or `timeout` elapsed with no
    delivery report at all (the callback never fired). Carries `topic` and
    `key` so a caller's own log line, and this exception's message, can
    both name the exact message that did not make it."""

    def __init__(self, topic: str, key: bytes | None, error: object):
        self.topic = topic
        self.key = key
        self.error = error
        super().__init__(f"delivery to {topic!r} (key={key!r}) failed: {error}")


class _Pending:
    __slots__ = ("topic", "key", "delivered", "error")

    def __init__(self, topic: str, key: bytes | None):
        self.topic = topic
        self.key = key
        self.delivered = False
        self.error = None


def send(
    producer,
    messages: Sequence[tuple[str, bytes, bytes | None]],
    *,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> None:
    """Produce every `(topic, value, key)` in `messages` on `producer`,
    then block for every one's delivery report.

    Returns normally only when every message was confirmed delivered by the
    broker. Raises `DeliveryFailed`, naming the first message that was not
    — the broker reported an error for it, or `timeout` elapsed with its
    delivery callback never called at all — on any other outcome. Nothing
    here retries: what "not delivered" means for the caller's own
    bookkeeping (the assembler's counters, the gate's committed offset) is
    the caller's decision, made by letting this raise before it touches
    either.

    `producer` is used only through `.produce(topic, value=, key=,
    callback=)` and `.flush(timeout)` — the exact seam a fake object can
    stand in for in tests, same as `routes.run_once`'s injected consumer
    and producer.
    """
    pending = [_Pending(topic, key) for topic, _value, key in messages]

    def _make_callback(entry: _Pending):
        def _on_delivery(err, _msg):
            entry.delivered = True
            entry.error = err
        return _on_delivery

    for (topic, value, key), entry in zip(messages, pending):
        producer.produce(topic, value=value, key=key, callback=_make_callback(entry))

    producer.flush(timeout)

    for entry in pending:
        if not entry.delivered:
            raise DeliveryFailed(entry.topic, entry.key, "delivery timed out")
        if entry.error is not None:
            raise DeliveryFailed(entry.topic, entry.key, entry.error)


def send_one(
    producer,
    topic: str,
    value: bytes,
    key: bytes | None,
    *,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> None:
    """`send` for exactly one message — the shape both callers actually use
    today: the assembler produces one record per episode, and the gate
    produces one admitted record per route, each confirmed on its own."""
    send(producer, [(topic, value, key)], timeout=timeout)
