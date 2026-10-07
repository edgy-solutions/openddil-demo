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
A retryable outcome (a 408/429/5xx/connection error, a credential that has
not arrived yet, or the delivered-events store being unreachable) is
retried in place, with the injected `sleep` backing off between attempts,
until it reaches a terminal outcome. Nothing is committed until every entry
a message matched has reached one. This keeps the whole thing synchronous
and keeps "retry the same record" literally true — there is no second
message to redeliver, because this process never let go of the first one.

DEDUPE AND THE ONE ACCEPTED WINDOW
Every Restate wipe and every scenario reset re-emits CM revisions, and a
revision reuses its event_id, so the same event can reach this process more
than once across restarts even though the destination already has it. A
route with `dedupe_field` set consults `egress_delivered_events` before
every send and never sends an event_id already recorded there as
delivered, so this side does not depend on the destination's own
idempotency to avoid a double send. The one window this does not close: a
crash after the destination returns 2xx and before the row recording it is
written can still re-send that one event after a restart — the POST and
the row write are not one transaction.
"""
from __future__ import annotations

import asyncio
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
from types import MappingProxyType
from typing import Any, Callable, Mapping

from client_credentials import ClientCredentials, parse_auth
from startup import require_tables, require_topics

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
POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN", "postgres://postgres:password@postgres-hq:5432/openddil")

# No case_id was found on the delivered/duplicate outcome this log line
# reports — distinct from `None`, which means a case_id was looked for and
# is genuinely absent (logged as `"case_id": null`). Every other outcome
# never passes `case_id` at all, so its log line carries no such key.
_NO_CASE_ID = object()


class ForwardConfigError(ValueError):
    """The forward config failed to load. The message names the entry, the
    same convention `routes.RouteError` and `assembler.AssemblerConfigError`
    use."""


@dataclass(frozen=True)
class Envelope:
    """The field names an entry's envelope writes at, plus any `static`
    fields written at fixed values on every record this route forwards
    (`envelope.static` in config — e.g. a destination-specific constant
    tag). The default reproduces `{"kind": <kind>, "id": <kafka key>,
    "payload": <the record JSON, parsed>}` — a destination with its own
    field names configures them here instead of this module growing a
    second envelope shape."""

    kind_field: str = "kind"
    id_field: str = "id"
    body_field: str = "payload"
    static: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True)
class ForwardRoute:
    """One row of `OPENDDIL_FORWARD_CONFIG`: a sink topic to consume, the
    destination URL to POST to, the kind the envelope declares, and
    optionally where to read a bearer token from before each request --
    either a static `token_file`, or an `auth` client_credentials grant.
    The two are exclusive (`load_forward_config` enforces it): a route
    carries one bearer-token source or the other, never both.

    `held`: a held route never POSTs — every record it matches ends in
    outcome `held` instead. `dedupe_field`: the top-level key of the
    decoded record carrying that record's event identity (the lab and
    chart docs use "event_id"); when set, every record is checked against
    `egress_delivered_events` before a send, and the route's own deliveries
    are recorded there. When unset, behaviour is exactly what it was before
    either field existed — the store is never consulted or written."""

    name: str
    sink_topic: str
    url: str
    kind: str
    envelope: Envelope = field(default_factory=Envelope)
    token_file: str | None = None
    auth: ClientCredentials | None = None
    held: bool = False
    dedupe_field: str | None = None


def _entry_label(entry: object, index: int) -> str:
    if isinstance(entry, Mapping) and entry.get("name") is not None:
        return repr(entry["name"])
    return f"entry #{index}"


def load_forward_config(path: str | os.PathLike) -> list[ForwardRoute]:
    """Load `OPENDDIL_FORWARD_CONFIG`: a JSON list of `{name, sink_topic,
    url, kind, envelope? (kind_field?, id_field?, body_field?, static?),
    token_file?, held?, dedupe_field?}` entries. Names must be unique and
    non-empty. `envelope.static` is a JSON object of extra fixed fields
    written on every record this route forwards; its keys must be
    non-empty strings that don't collide with kind_field/id_field/
    body_field, and its values must be JSON scalars (string/number/
    boolean), never nested objects. `held` must be a boolean; `dedupe_field`
    must be a non-empty string. A bad file raises `ForwardConfigError`
    naming the entry."""
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
        kind_field = envelope_raw.get("kind_field", "kind")
        id_field = envelope_raw.get("id_field", "id")
        body_field = envelope_raw.get("body_field", "payload")

        static_raw = envelope_raw.get("static") or {}
        if not isinstance(static_raw, Mapping):
            raise ForwardConfigError(f"{label}: 'envelope.static' must be a JSON object")
        static: dict[str, Any] = {}
        for static_key, static_value in static_raw.items():
            if not isinstance(static_key, str) or not static_key:
                raise ForwardConfigError(f"{label}: 'envelope.static' keys must be non-empty strings")
            if static_key in (kind_field, id_field, body_field):
                raise ForwardConfigError(
                    f"{label}: 'envelope.static' key {static_key!r} collides with a named envelope field"
                )
            if not isinstance(static_value, (str, int, float, bool)):
                raise ForwardConfigError(
                    f"{label}: 'envelope.static' value for {static_key!r} must be a string, number or boolean"
                )
            static[static_key] = static_value

        envelope = Envelope(
            kind_field=kind_field,
            id_field=id_field,
            body_field=body_field,
            static=MappingProxyType(static),
        )

        token_file = entry.get("token_file")
        try:
            auth = parse_auth(entry.get("auth"), label)
        except ValueError as exc:
            raise ForwardConfigError(str(exc)) from exc
        if token_file is not None and auth is not None:
            raise ForwardConfigError(f"{label}: token_file and auth are exclusive")

        held = entry.get("held", False)
        if not isinstance(held, bool):
            raise ForwardConfigError(f"{label}: 'held' must be a boolean")

        dedupe_field = entry.get("dedupe_field")
        if dedupe_field is not None and (not isinstance(dedupe_field, str) or not dedupe_field):
            raise ForwardConfigError(f"{label}: 'dedupe_field' must be a non-empty string")

        routes.append(ForwardRoute(
            name=name, sink_topic=entry["sink_topic"], url=entry["url"],
            kind=entry["kind"], envelope=envelope, token_file=token_file, auth=auth,
            held=held, dedupe_field=dedupe_field,
        ))
    return routes


def build_envelope(route: ForwardRoute, key: str | None, record: Mapping[str, Any]) -> dict[str, Any]:
    """The wire envelope for one record: `route.envelope.static`'s fixed
    fields written first, then `route`'s declared kind, the Kafka key, and
    the parsed record, written last at the field names `route.envelope`
    names — the default envelope when none were configured. The order
    keeps the three named fields from ever being shadowed by a static one,
    though `load_forward_config`'s collision check already makes that
    impossible by construction."""
    envelope: dict[str, Any] = dict(route.envelope.static)
    envelope[route.envelope.kind_field] = route.kind
    envelope[route.envelope.id_field] = key
    envelope[route.envelope.body_field] = record
    return envelope


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


class DeliveredStore:
    """Synchronous cover over `egress_delivered_events`, for a process that
    is otherwise plain blocking code (see the module docstring on why
    `_deliver`'s retry is a loop, not a second poll): one event loop and
    one connection, opened lazily and held across calls rather than
    reconnected every time, because this store sits in front of every send
    a dedupe route makes. A call that fails drops the connection so the
    next call reconnects rather than retrying over one already dead;
    `_deliver`'s own backoff loop is what makes that retry happen."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._loop = asyncio.new_event_loop()
        self._conn = None

    def _call(self, body):
        async def _run():
            import asyncpg  # noqa: PLC0415
            if self._conn is None:
                self._conn = await asyncpg.connect(self._dsn)
            try:
                return await body(self._conn)
            except Exception:
                try:
                    await self._conn.close()
                except Exception:  # noqa: BLE001 — already failing; don't mask it
                    pass
                self._conn = None
                raise
        return self._loop.run_until_complete(_run())

    def lookup(self, route: str, event_id: str) -> Mapping[str, Any] | None:
        """The stored row for (route, event_id), or `None` if there isn't
        one. `_deliver` treats an exception here as `store_unavailable`."""
        async def _fetch(conn):
            return await conn.fetchrow(
                'SELECT "outcome", "case_id" FROM "egress_delivered_events"'
                ' WHERE "route" = $1 AND "event_id" = $2',
                route, event_id,
            )
        row = self._call(_fetch)
        return dict(row) if row is not None else None

    def upsert_held(
        self, *, route: str, event_id: str, topic: str | None, partition: int | None, offset: int | None,
    ) -> None:
        self._upsert(
            route=route, event_id=event_id, outcome="held", http_status=None, case_id=None,
            topic=topic, partition=partition, offset=offset,
        )

    def upsert_delivered(
        self, *, route: str, event_id: str, http_status: int, case_id: str | None,
        topic: str | None, partition: int | None, offset: int | None,
    ) -> None:
        self._upsert(
            route=route, event_id=event_id, outcome="delivered", http_status=http_status, case_id=case_id,
            topic=topic, partition=partition, offset=offset,
        )

    def _upsert(
        self, *, route: str, event_id: str, outcome: str, http_status: int | None, case_id: str | None,
        topic: str | None, partition: int | None, offset: int | None,
    ) -> None:
        # A 'delivered' row is never downgraded to 'held': the caller's own
        # ordering already guarantees this (a 'delivered' row short-circuits
        # as `duplicate` before the held branch is ever reached), and the
        # WHERE guard below holds the same line durably, at the one place
        # that actually writes the row.
        async def _exec(conn):
            await conn.execute(
                """
                INSERT INTO "egress_delivered_events" (
                    "route", "event_id", "outcome", "http_status", "case_id",
                    "topic", "partition", "kafka_offset", "first_recorded_at", "recorded_at")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
                ON CONFLICT ("route", "event_id") DO UPDATE SET
                    "outcome" = excluded."outcome",
                    "http_status" = excluded."http_status",
                    "case_id" = excluded."case_id",
                    "topic" = excluded."topic",
                    "partition" = excluded."partition",
                    "kafka_offset" = excluded."kafka_offset",
                    "recorded_at" = excluded."recorded_at"
                WHERE "egress_delivered_events"."outcome" != 'delivered' OR excluded."outcome" = 'delivered'
                """,
                route, event_id, outcome, http_status, case_id, topic, partition, offset,
            )
        self._call(_exec)


def _log_outcome(
    name: str, key: str | None, kind: str | None, status: int | None, outcome: str,
    *, case_id: Any = _NO_CASE_ID,
) -> None:
    payload: dict[str, Any] = {"forward": name, "key": key, "kind": kind, "status": status, "outcome": outcome}
    if case_id is not _NO_CASE_ID:
        payload["case_id"] = case_id
    log.info(json.dumps(payload))


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
    log_outcome: Callable[..., None],
    store: DeliveredStore | None = None,
    topic: str | None = None,
    partition: int | None = None,
    offset: int | None = None,
) -> None:
    """Deliver one record to one route, blocking and retrying with backoff
    until a terminal outcome (held, duplicate, no_event_id, delivered or
    rejected) is reached. See the module docstring on why this is a loop
    here rather than a second poll.

    `store` is only ever touched when `route.dedupe_field` is set — a route
    without it is unchanged from before either field existed. `topic`/
    `partition`/`offset` are the sink message's own position, carried
    through only so a dedupe route's stored row can record them.
    """
    event_id: str | None = None
    if route.dedupe_field is not None:
        raw_event_id = record.get(route.dedupe_field)
        if not isinstance(raw_event_id, str) or not raw_event_id:
            _bump(counts, "no_event_id")
            log_outcome(route.name, key, route.kind, None, "no_event_id")
            return
        event_id = raw_event_id

    delay = INITIAL_BACKOFF_S
    while True:
        if route.dedupe_field is not None:
            try:
                existing = store.lookup(route.name, event_id)
            except Exception as exc:  # noqa: BLE001 — any store failure here
                log.warning("delivered-events store unavailable (route=%s): %s", route.name, exc)
                _bump(counts, "store_unavailable")
                log_outcome(route.name, key, route.kind, None, "store_unavailable")
                sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF_S)
                continue
            if existing is not None and existing.get("outcome") == "delivered":
                _bump(counts, "duplicate")
                log_outcome(route.name, key, route.kind, None, "duplicate", case_id=existing.get("case_id"))
                return

        if route.held:
            if route.dedupe_field is not None:
                try:
                    store.upsert_held(route=route.name, event_id=event_id, topic=topic, partition=partition, offset=offset)
                except Exception as exc:  # noqa: BLE001 — any store failure here
                    log.warning("delivered-events store unavailable (route=%s): %s", route.name, exc)
                    _bump(counts, "store_unavailable")
                    log_outcome(route.name, key, route.kind, None, "store_unavailable")
                    sleep(delay)
                    delay = min(delay * 2, MAX_BACKOFF_S)
                    continue
            _bump(counts, "held")
            log_outcome(route.name, key, route.kind, None, "held")
            return

        token: str | None = None
        if route.token_file:
            token = read_token(route.token_file)
            if token is None:
                _bump(counts, "no_credential")
                log_outcome(route.name, key, route.kind, None, "no_credential")
                sleep(delay)
                delay = min(delay * 2, MAX_BACKOFF_S)
                continue
        elif route.auth is not None:
            token = route.auth.token()
            if token is None:
                # Same no_credential path a missing token_file takes --
                # an unavailable destination credential is the same
                # operational event regardless of which source it came from.
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
            case_id: str | None = None
            try:
                parsed_body = json.loads(resp_body)
            except (ValueError, UnicodeDecodeError):
                parsed_body = None
            if isinstance(parsed_body, Mapping):
                maybe_case_id = parsed_body.get("case_id")
                if isinstance(maybe_case_id, str) and maybe_case_id:
                    case_id = maybe_case_id
            # Never log the rest of the body -- only the case_id it carried.

            if route.dedupe_field is not None:
                while True:
                    try:
                        store.upsert_delivered(
                            route=route.name, event_id=event_id, http_status=status, case_id=case_id,
                            topic=topic, partition=partition, offset=offset,
                        )
                        break
                    except Exception as exc:  # noqa: BLE001 — any store failure here
                        # Retry THE WRITE, never the POST: the destination
                        # already accepted this record.
                        log.warning("delivered-events store unavailable (route=%s): %s", route.name, exc)
                        _bump(counts, "store_unavailable")
                        log_outcome(route.name, key, route.kind, None, "store_unavailable")
                        sleep(delay)
                        delay = min(delay * 2, MAX_BACKOFF_S)

            _bump(counts, "delivered")
            log_outcome(route.name, key, route.kind, status, "delivered", case_id=case_id)
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
    log_outcome: Callable[..., None] = _log_outcome,
    store: DeliveredStore | None = None,
) -> bool:
    """Poll once. Decode once; hand the record to every configured entry
    whose sink topic matches, each delivered (and retried) in turn; commit
    once, after every matching entry has reached a terminal outcome.

    `store` is passed straight through to `_deliver`, which only ever
    touches it for a route that sets `dedupe_field`.

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
                store=store, topic=msg.topic(), partition=msg.partition(), offset=msg.offset(),
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

    # R6b: every sink topic this process consumes must exist first, and —
    # when any route sets dedupe_field — so must egress_delivered_events.
    if routes_by_topic:
        from confluent_kafka.admin import AdminClient  # noqa: PLC0415
        require_topics(
            AdminClient({"bootstrap.servers": BROKERS}), sorted(routes_by_topic))
        if any(route.dedupe_field is not None for route in routes):
            asyncio.run(require_tables(POSTGRES_DSN, ["egress_delivered_events"]))

    store = DeliveredStore(POSTGRES_DSN) if any(route.dedupe_field is not None for route in routes) else None

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
                counts=counts, store=store,
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
