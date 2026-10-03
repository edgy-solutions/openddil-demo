"""forwarder.py — carries an admitted record from its sink topic to its
destination over HTTP.

The gate (routes.py) decides a record and produces it, byte for byte, to the
route's sink topic. This module is the next and last hop: it consumes one or
more sink topics and POSTs each record to the destination that sink topic's
route names, wrapped in that destination's envelope.

ONE CONSUMER, MANY DESTINATIONS, THE SAME SHAPE ROUTES.PY ALREADY USES
`run_once` polls once, decodes once, and hands the decoded record to every
configured entry whose sink topic matches — the same fan-out and the same
"decode once, undecodable is per matching entry, commit once at the end"
shape `routes.run_once` uses for the gate's own fan-out. No `confluent_kafka`
import here: `consumer` is used only through `.poll`, `.error`, `.topic`,
`.key`, `.value` and `.commit` — the exact seam a fake object can stand in
for in tests.

RETRY IS A BLOCKING LOOP INSIDE ONE MESSAGE, NOT A SECOND POLL
A retryable outcome (a 408/429/5xx/connection error, or a credential that
has not arrived yet) is retried in place, with the injected `sleep` backing
off between attempts, until it reaches a terminal outcome. Nothing is
committed until every entry a message matched has reached one. This keeps
the whole thing synchronous and keeps "retry the same record" literally
true — there is no second message to redeliver, because this process never
let go of the first one.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from startup import require_topics

log = logging.getLogger("egress.forwarder")

CONFIG_PATH = os.getenv("OPENDDIL_FORWARD_CONFIG")
BROKERS = os.getenv("OPENDDIL_EGRESS_BROKERS", "redpanda-hq:19092")
GROUP = os.getenv("OPENDDIL_FORWARD_GROUP", "egress-forwarder")
POLL_TIMEOUT = float(os.getenv("OPENDDIL_EGRESS_POLL_TIMEOUT", "1.0"))
HTTP_TIMEOUT_S = float(os.getenv("OPENDDIL_FORWARD_HTTP_TIMEOUT_S", "5.0"))
INITIAL_BACKOFF_S = float(os.getenv("OPENDDIL_FORWARD_INITIAL_BACKOFF_S", "1.0"))
MAX_BACKOFF_S = float(os.getenv("OPENDDIL_FORWARD_MAX_BACKOFF_S", "30.0"))
COUNTER_LOG_INTERVAL_S = 60.0
REJECTED_BODY_LOG_BYTES = 300


class ForwardConfigError(ValueError):
    """The forward config failed to load. The message names the entry, the
    same convention `routes.RouteError` and `assembler.AssemblerConfigError`
    use."""


@dataclass(frozen=True)
class Envelope:
    """The field names an entry's envelope writes at. The default
    reproduces `{"kind": <kind>, "id": <kafka key>, "payload": <the record
    JSON, parsed>}` — a destination with its own field names configures
    them here instead of this module growing a second envelope shape."""

    kind_field: str = "kind"
    id_field: str = "id"
    body_field: str = "payload"


@dataclass(frozen=True)
class ForwardRoute:
    """One row of `OPENDDIL_FORWARD_CONFIG`: a sink topic to consume, the
    destination URL to POST to, the kind the envelope declares, and
    optionally where to read a bearer token from before each request."""

    name: str
    sink_topic: str
    url: str
    kind: str
    envelope: Envelope = field(default_factory=Envelope)
    token_file: str | None = None


def _entry_label(entry: object, index: int) -> str:
    if isinstance(entry, Mapping) and entry.get("name") is not None:
        return repr(entry["name"])
    return f"entry #{index}"


def load_forward_config(path: str | os.PathLike) -> list[ForwardRoute]:
    """Load `OPENDDIL_FORWARD_CONFIG`: a JSON list of `{name, sink_topic,
    url, kind, envelope?, token_file?}` entries. Names must be unique and
    non-empty. A bad file raises `ForwardConfigError` naming the entry."""
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, list):
        raise ForwardConfigError(f"{path}: must be a JSON list of entries")

    seen: set[str] = set()
    routes: list[ForwardRoute] = []
    for index, entry in enumerate(raw):
        label = _entry_label(entry, index)
        if not isinstance(entry, Mapping):
            raise ForwardConfigError(f"{label}: entry must be a JSON object")

        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise ForwardConfigError(f"{label}: 'name' must be a non-empty string")
        if name in seen:
            raise ForwardConfigError(f"{label}: duplicate name")
        seen.add(name)

        missing = [f for f in ("sink_topic", "url", "kind") if f not in entry]
        if missing:
            raise ForwardConfigError(f"{label}: missing required field(s) {missing}")

        envelope_raw = entry.get("envelope") or {}
        if not isinstance(envelope_raw, Mapping):
            raise ForwardConfigError(f"{label}: 'envelope' must be a JSON object")
        envelope = Envelope(
            kind_field=envelope_raw.get("kind_field", "kind"),
            id_field=envelope_raw.get("id_field", "id"),
            body_field=envelope_raw.get("body_field", "payload"),
        )

        routes.append(ForwardRoute(
            name=name, sink_topic=entry["sink_topic"], url=entry["url"],
            kind=entry["kind"], envelope=envelope, token_file=entry.get("token_file"),
        ))
    return routes


def build_envelope(route: ForwardRoute, key: str | None, record: Mapping[str, Any]) -> dict[str, Any]:
    """The wire envelope for one record: `route`'s declared kind, the
    Kafka key, and the parsed record, written at the field names
    `route.envelope` names — the default envelope when none were
    configured."""
    return {
        route.envelope.kind_field: route.kind,
        route.envelope.id_field: key,
        route.envelope.body_field: record,
    }


def _default_read_token(path: str) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def _default_post(url: str, data: bytes, headers: Mapping[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError as exc:
        # A connection error — DNS failure, refused connection, timeout.
        # Raised, not returned, so the caller's retry branch is the only
        # place that reads it, the same way a bad status code never is.
        raise OSError(str(exc.reason)) from exc


def _log_outcome(name: str, key: str | None, kind: str | None, status: int | None, outcome: str) -> None:
    log.info(json.dumps({"forward": name, "key": key, "kind": kind, "status": status, "outcome": outcome}))


def _bump(counts: dict[str, int], outcome: str) -> None:
    counts[outcome] = counts.get(outcome, 0) + 1


def _deliver(
    route: ForwardRoute,
    key: str | None,
    record: Mapping[str, Any],
    *,
    post: Callable[[str, bytes, Mapping[str, str]], tuple[int, bytes]],
    sleep: Callable[[float], None],
    read_token: Callable[[str], str | None],
    counts: dict[str, int],
    log_outcome: Callable[[str, str | None, str | None, int | None, str], None],
) -> None:
    """Deliver one record to one route, blocking and retrying with backoff
    until a terminal outcome (delivered or rejected) is reached. See the
    module docstring on why this is a loop here rather than a second poll."""
    delay = INITIAL_BACKOFF_S
    while True:
        token: str | None = None
        if route.token_file:
            token = read_token(route.token_file)
            if token is None:
                _bump(counts, "no_credential")
                log_outcome(route.name, key, route.kind, None, "no_credential")
                sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF_S)
                continue

        body = json.dumps(build_envelope(route, key, record), separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            status, resp_body = post(route.url, body, headers)
        except OSError as exc:
            log.warning("connection error forwarding to %s (route=%s): %s", route.url, route.name, exc)
            _bump(counts, "retried")
            log_outcome(route.name, key, route.kind, None, "retried")
            sleep(delay)
            delay = min(delay * 2, MAX_BACKOFF_S)
            continue

        if 200 <= status < 300:
            _bump(counts, "delivered")
            log_outcome(route.name, key, route.kind, status, "delivered")
            return

        if status in (408, 429) or status >= 500:
            _bump(counts, "retried")
            log_outcome(route.name, key, route.kind, status, "retried")
            sleep(delay)
            delay = min(delay * 2, MAX_BACKOFF_S)
            continue

        # Another 4xx: a destination refusing a record is a decision, not
        # an outage. Logged and counted, never retried.
        log.warning(
            "rejected by %s (route=%s): status=%s body=%r",
            route.url, route.name, status, resp_body[:REJECTED_BODY_LOG_BYTES],
        )
        _bump(counts, "rejected")
        log_outcome(route.name, key, route.kind, status, "rejected")
        return


def run_once(
    consumer,
    *,
    routes_by_topic: Mapping[str, list[ForwardRoute]],
    decode: Callable[[bytes], Mapping[str, Any]],
    post: Callable[[str, bytes, Mapping[str, str]], tuple[int, bytes]],
    sleep: Callable[[float], None],
    poll_timeout: float,
    counts: dict[str, int],
    read_token: Callable[[str], str | None] = _default_read_token,
    log_outcome: Callable[[str, str | None, str | None, int | None, str], None] = _log_outcome,
) -> bool:
    """Poll once. Decode once; hand the record to every configured entry
    whose sink topic matches, each delivered (and retried) in turn; commit
    once, after every matching entry has reached a terminal outcome.

    Returns `True` when a message was processed, `False` on an empty poll
    (a consumer error counts as empty), the same contract `routes.run_once`
    gives its caller.
    """
    msg = consumer.poll(poll_timeout)
    if msg is None:
        return False
    if msg.error():
        log.warning("consumer error: %s", msg.error())
        return False

    key = msg.key().decode("utf-8", "replace") if msg.key() else None
    matching = routes_by_topic.get(msg.topic(), [])

    try:
        record = decode(msg.value())
    except Exception as exc:  # noqa: BLE001
        # Per-entry, the same way routes.run_once logs an undecodable
        # record against every matching route: the record was never
        # forwarded by any of them, but each still gets its own line.
        for route in matching:
            log.warning("undecodable message for route=%s: %s", route.name, exc)
            _bump(counts, "undecodable")
            log_outcome(route.name, key, route.kind, None, "undecodable")
    else:
        for route in matching:
            _deliver(
                route, key, record, post=post, sleep=sleep,
                read_token=read_token, counts=counts, log_outcome=log_outcome,
            )

    consumer.commit(msg, asynchronous=False)
    return True


def log_counters(counts: Mapping[str, int]) -> None:
    log.info("forwarder counters %s", json.dumps(dict(counts), sort_keys=True))


# --- process wiring ----------------------------------------------------------

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [forwarder] %(message)s",
    stream=sys.stdout,
)

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s — draining and stopping", signum)
    _running = False


def _decode(payload: bytes) -> dict:
    return json.loads(payload.decode("utf-8"))


def main() -> int:
    from confluent_kafka import Consumer  # noqa: PLC0415

    if not CONFIG_PATH:
        log.error("FATAL: OPENDDIL_FORWARD_CONFIG is not set")
        return 2

    try:
        routes = load_forward_config(CONFIG_PATH)
    except Exception as exc:  # noqa: BLE001 — a bad config must not start the forwarder
        log.error("FATAL: forward config failed to load: %s", exc)
        return 2

    routes_by_topic: dict[str, list[ForwardRoute]] = {}
    for route in routes:
        routes_by_topic.setdefault(route.sink_topic, []).append(route)

    # R6b: every sink topic this process consumes must exist first.
    if routes_by_topic:
        from confluent_kafka.admin import AdminClient  # noqa: PLC0415
        require_topics(
            AdminClient({"bootstrap.servers": BROKERS}), sorted(routes_by_topic))

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    consumer = Consumer({
        "bootstrap.servers": BROKERS,
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    consumer.subscribe(sorted(routes_by_topic))

    counts: dict[str, int] = {}
    last_counter_log = time.monotonic()
    try:
        while _running:
            run_once(
                consumer, routes_by_topic=routes_by_topic, decode=_decode,
                post=_default_post, sleep=time.sleep, poll_timeout=POLL_TIMEOUT,
                counts=counts,
            )
            now = time.monotonic()
            if now - last_counter_log >= COUNTER_LOG_INTERVAL_S:
                log_counters(counts)
                last_counter_log = now
    finally:
        log_counters(counts)
        consumer.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
