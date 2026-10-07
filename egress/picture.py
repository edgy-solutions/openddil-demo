#!/usr/bin/env python3
"""Read-only current-picture endpoint for the assembler process.

    GET /picture?event_id=<id>&destination=<dest>

returns the CURRENT record for the episode `event_id` names, rebuilt now from
current state and released through the egress gate toward `destination`. A
consumer that was told about an event re-reads the picture here instead of
trusting the copy the event carried, which may be stale by the time it is read.

WHO CALLS THIS, AND WHY `destination` IS A QUERY PARAMETER
The only caller is the hub's policy enforcement point. It validates the
consumer's token and sets `destination` itself; the consumer never chooses
it. This endpoint therefore trusts its query string, the same way
`pane_api.py`'s `/decisions?destination=` does. It must not be published
anywhere a consumer can reach directly.

THE INDEX
An event id is the assembler's own record key (`record_key`), a uuid5 with no
reverse. `EpisodeIndex` maps each key back to the (route, cm-state, episode,
owning tier) that produced it, built only with the assembler's own functions
(`episodes`, `record_key`, `owning_tier_of`) so it cannot disagree with the
keys the producing loop emits. Each message for an asset replaces that
asset's entries for that route, so an episode that is no longer open is
unknown afterwards: a cleared fault answers 404, never a stale record.

WHY THE INDEX HAS ITS OWN GROUPLESS CONSUMER
The producing loop commits offsets, so after a restart it resumes past
messages it already handled and its view of open episodes is only what has
arrived since. The index must be complete the moment the process is up, so
it reads every partition of each trigger topic from the earliest offset with
no committed group state, independent of the main consumer. It only reads.

WHAT IS NOT HERE
No write path, no produce, no change to the producing loop. With the feature
off (the default) nothing in this module starts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping

from assembler import (
    AssemblerRoute,
    Episode,
    ReadAsset,
    _RouteState,
    _decode,
    _label_from_cm_state,
    assemble,
    build_route_picture,
    episodes,
    owning_tier_of,
    record_key,
)
from gate import AuthzUnavailable, EgressGate

log = logging.getLogger("egress.picture")

DEFAULT_PORT = 8097


def picture_enabled(env: Mapping[str, str]) -> bool:
    return (env.get("OPENDDIL_PICTURE_ENABLED") or "").strip().lower() in ("1", "true")


# --- the index --------------------------------------------------------------

@dataclass(frozen=True)
class IndexEntry:
    route: AssemblerRoute
    cm_state: Mapping[str, Any]
    episode: Episode
    owning_tier: str


class EpisodeIndex:
    """event_id -> IndexEntry. Written by the feeder thread, read by the
    HTTP server's threads, so every access holds the lock."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_key: dict[str, IndexEntry] = {}
        self._keys_by_asset: dict[tuple[str, str], set[str]] = {}

    def __len__(self) -> int:
        with self._lock:
            return len(self._by_key)

    def lookup(self, event_id: str) -> IndexEntry | None:
        with self._lock:
            return self._by_key.get(event_id)

    def update(self, route: AssemblerRoute, cm_state: Mapping[str, Any]) -> None:
        """Replace this asset's entries for this route with the open
        episodes of `cm_state`."""
        tier = owning_tier_of(cm_state)
        fresh: dict[str, IndexEntry] = {}
        for ep in episodes(cm_state):
            key = record_key(route.kind, tier, ep.asset, ep.component,
                             ep.fault_code, ep.detected_at_ns)
            fresh[key] = IndexEntry(route, cm_state, ep, tier)
        slot = (route.name, cm_state.get("asset_id", ""))
        with self._lock:
            for old in self._keys_by_asset.pop(slot, ()):
                self._by_key.pop(old, None)
            if fresh:
                self._by_key.update(fresh)
                self._keys_by_asset[slot] = set(fresh)

    def remove(self, route: AssemblerRoute, asset_id: str) -> None:
        """A tombstone: the asset has no entries afterwards."""
        with self._lock:
            for old in self._keys_by_asset.pop((route.name, asset_id), ()):
                self._by_key.pop(old, None)


# --- the answer -------------------------------------------------------------

GateFor = Callable[[str, str], EgressGate]


def answer(
    event_id: str | None,
    destination: str | None,
    *,
    index: EpisodeIndex,
    routes_state: Mapping[str, _RouteState],
    read_asset: ReadAsset,
    gate_for: GateFor,
    now: datetime,
) -> tuple[int, dict[str, Any]]:
    """(status, body) for one request. No HTTP, no Kafka: everything it
    touches is passed in."""
    if not event_id or not destination:
        return 400, {"detail": "event_id and destination are required"}
    entry = index.lookup(event_id)
    if entry is None:
        return 404, {"detail": "unknown event_id: no open episode has this id"}

    state = routes_state[entry.route.name]
    try:
        picture = asyncio.run(build_route_picture(
            state, entry.cm_state, entry.episode, entry.owning_tier,
            read_asset=read_asset))
    except Exception:  # noqa: BLE001 — never a partial record
        log.exception("picture build failed for event_id=%s", event_id)
        return 503, {"detail": "picture unavailable"}
    record = assemble(
        entry.route.kind, state.declarations, state.schema, entry.cm_state,
        entry.episode, picture, now)

    try:
        gate = gate_for(destination, entry.route.kind)
    except AuthzUnavailable as exc:
        log.warning("PDP unavailable for destination=%s: %s", destination, exc)
        return 503, {"detail": "authorization unavailable"}
    label = _label_from_cm_state(entry.cm_state) or {}
    decision = gate.decide(label, key=event_id)
    if not decision.allowed:
        return 403, {
            "event_id": event_id,
            "destination": destination,
            "decision_id": decision.decision_id,
            "reason": decision.reason,
            "policy_version": decision.policy_version,
            "corpus_version": decision.corpus_version,
        }
    return 200, {
        "event_id": event_id,
        "kind": entry.route.kind,
        "destination": destination,
        "decision_id": decision.decision_id,
        "policy_version": decision.policy_version,
        "corpus_version": decision.corpus_version,
        "record": record,
    }


# --- HTTP -------------------------------------------------------------------

def make_handler(
    index: EpisodeIndex,
    routes_state: Mapping[str, _RouteState],
    read_asset: ReadAsset,
    gate_for: GateFor,
) -> type[BaseHTTPRequestHandler]:
    class PictureApi(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter access log
            log.debug(fmt, *args)

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/picture":
                self._send(404, {"detail": "unknown path"})
                return
            params = urllib.parse.parse_qs(parsed.query)
            event_id = (params.get("event_id") or [""])[0]
            destination = (params.get("destination") or [""])[0]
            try:
                status, body = answer(
                    event_id, destination, index=index,
                    routes_state=routes_state, read_asset=read_asset,
                    gate_for=gate_for, now=datetime.now(timezone.utc))
            except Exception:  # noqa: BLE001 — a body beats a hang
                log.exception("unhandled error serving /picture")
                status, body = 500, {"detail": "internal error"}
            log.info("picture event_id=%s destination=%s status=%d %s",
                     event_id, destination, status,
                     body.get("reason") or body.get("decision_id") or body.get("detail", ""))
            self._send(status, body)

        def _method_not_allowed(self) -> None:
            self._send(405, {"detail": "method not allowed"})

        do_POST = do_PUT = do_DELETE = do_PATCH = _method_not_allowed  # noqa: N815

    return PictureApi


# --- feeding the index ------------------------------------------------------

def _feed_forever(index: EpisodeIndex, routes: list[AssemblerRoute], brokers: str) -> None:
    import secrets  # noqa: PLC0415

    from confluent_kafka import OFFSET_BEGINNING, Consumer, TopicPartition  # noqa: PLC0415

    consumer = Consumer({
        "bootstrap.servers": brokers,
        # confluent_kafka insists on a group id; this one is random, never
        # committed to, and never resumed from.
        "group.id": f"egress-picture-index-{secrets.token_hex(4)}",
        "enable.auto.commit": False,
    })
    by_topic: dict[str, list[AssemblerRoute]] = {}
    for route in routes:
        by_topic.setdefault(route.trigger_topic, []).append(route)
    assignments = []
    for topic in by_topic:
        meta = consumer.list_topics(topic=topic, timeout=10)
        for p in sorted(meta.topics[topic].partitions):
            assignments.append(TopicPartition(topic, p, OFFSET_BEGINNING))
    consumer.assign(assignments)
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        try:
            targets = by_topic.get(msg.topic(), [])
            value = msg.value()
            if not value:
                key = (msg.key() or b"").decode("utf-8", "replace")
                if key:
                    for route in targets:
                        index.remove(route, key)
                continue
            record = _decode(value)
            for route in targets:
                index.update(route, record)
        except Exception as exc:  # noqa: BLE001 — one bad message must not stop the feed
            log.warning("picture index skipped a message on %s: %s", msg.topic(), exc)


def start(
    routes: list[AssemblerRoute],
    states: Mapping[str, _RouteState],
    brokers: str,
    read_asset: ReadAsset,
) -> EpisodeIndex:
    """Start the index feeder and the HTTP server, each in a daemon thread
    for the life of the process."""
    index = EpisodeIndex()
    threading.Thread(target=_feed_forever, args=(index, routes, brokers),
                     name="picture-index", daemon=True).start()

    def gate_for(destination: str, kind: str) -> EgressGate:
        return EgressGate.for_destination(destination, kind=kind)

    port = int(os.getenv("OPENDDIL_PICTURE_PORT", str(DEFAULT_PORT)))
    server = ThreadingHTTPServer(
        ("0.0.0.0", port), make_handler(index, states, read_asset, gate_for))
    threading.Thread(target=server.serve_forever, name="picture-http",
                     daemon=True).start()
    log.info("picture endpoint listening on :%d", port)
    return index
