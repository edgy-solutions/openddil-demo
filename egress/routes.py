"""routes.py — the egress route table (ADR-0043).

One gate serves one destination (see gate.py's module docstring on why); a
deployment with several destinations now needs several gates sharing one
consumer, and this module is where that table and its fan-out loop live.

ENV FALLBACK, ON PURPOSE
When `OPENDDIL_EGRESS_ROUTES_PATH` is unset there is exactly one route, built
from the same env vars main.py has always read (`SOURCE_TOPIC`, `SINK_TOPIC`,
`DESTINATION`, `GROUP`), with name `None` and kind `None`. Today's single-
destination deployment is then unchanged: same group id, same subscription,
same decision JSON — this table is additive, not a migration every chart has
to make on the same day.

PER-ROUTE GROUP IS RESERVED, NOT SUPPORTED
Separate consumer groups per route would mean separate offsets, separate
rebalances and a subscription that is no longer "one consumer, one commit
per message" — a bigger design than this pass needs. A route file that asks
for one is refused at load, naming the entry, rather than silently ignored.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable, Mapping

from gate import Decision, EgressGate, REASON_UNDECODABLE, new_decision_id

log = logging.getLogger("egress.routes")

# The same env vars main.py has always read for the single-destination
# deployment. Centralised here so the env-fallback route and any future
# caller agree on one definition rather than two that can drift apart.
SOURCE_TOPIC = os.getenv("OPENDDIL_EGRESS_SOURCE_TOPIC", "asset-logistics-status")
SINK_TOPIC = os.getenv("OPENDDIL_EGRESS_SINK_TOPIC", "egress-c2-status")
DESTINATION = os.getenv("OPENDDIL_EGRESS_DESTINATION", "system:c2-stand-in-atl")
GROUP = os.getenv("OPENDDIL_EGRESS_GROUP", "egress-gate-c2")


class RouteError(ValueError):
    """The route table failed to load. The message names the entry."""


@dataclass(frozen=True)
class Route:
    """One row of the table: a source topic, a destination, a sink topic.

    `group` is carried only so a file that sets it can be refused by name —
    see the module docstring. It is always `None` on a `Route` that made it
    past `load_routes`.
    """

    name: str | None
    source_topic: str
    destination: str
    sink_topic: str
    kind: str | None = None
    group: str | None = None


def _entry_label(entry: object, index: int) -> str:
    if isinstance(entry, Mapping) and entry.get("name") is not None:
        return repr(entry["name"])
    return f"entry #{index}"


def load_routes(path: str | os.PathLike | None, known_kinds: Iterable[str] = ()) -> list[Route]:
    """Load the route table.

    `path` is `OPENDDIL_EGRESS_ROUTES_PATH`'s value (or `None`/empty when
    unset, in which case the single env-derived route is returned — see the
    module docstring). `known_kinds` is the set of kind names `kinds.py` has
    actually loaded; a route naming any other kind fails to load, naming the
    entry.
    """
    if not path:
        return [Route(
            name=None, source_topic=SOURCE_TOPIC, destination=DESTINATION,
            sink_topic=SINK_TOPIC, kind=None, group=None,
        )]

    known = set(known_kinds)
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, list):
        raise RouteError(f"{path}: routes file must be a JSON list of route entries")

    routes: list[Route] = []
    seen_names: set[object] = set()
    for index, entry in enumerate(raw):
        label = _entry_label(entry, index)
        if not isinstance(entry, Mapping):
            raise RouteError(f"{label}: route entry must be a JSON object")

        name = entry.get("name")
        if name in seen_names:
            raise RouteError(f"{label}: duplicate route name")
        seen_names.add(name)

        if entry.get("group") is not None:
            raise RouteError(f"{label}: per-route group is not supported in this pass")

        kind = entry.get("kind")
        if kind is not None and kind not in known:
            raise RouteError(f"{label}: unknown kind {kind!r}")

        missing = [f for f in ("source_topic", "destination", "sink_topic") if f not in entry]
        if missing:
            raise RouteError(f"{label}: missing required field(s) {missing}")

        routes.append(Route(
            name=name,
            source_topic=entry["source_topic"],
            destination=entry["destination"],
            sink_topic=entry["sink_topic"],
            kind=kind,
            group=None,
        ))
    return routes


def run_once(
    consumer,
    producer,
    *,
    routes_by_topic: Mapping[str, list[Route]],
    gates: Mapping[Route, EgressGate],
    decode: Callable[[bytes], Mapping],
    poll_timeout: float,
) -> bool:
    """Poll once. Decide the message by every route whose source topic
    matches, log one decision per matching route, produce to each admitted
    sink, then commit once.

    Returns `True` when a message was processed, `False` on an empty poll
    (a consumer error counts as empty — it is logged and left for the next
    poll), so the caller can just keep calling this until told to stop.

    No `confluent_kafka` import here: `consumer` and `producer` are used only
    through `.poll`, `.error`, `.topic`, `.key`, `.value`, `.commit` and
    `.produce` — the exact seam a fake object can stand in for, the same way
    test_gate.py injects the PDP answer instead of fetching it.
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
        # THE UNDECODABLE PATH IS PER ROUTE: the record was never evaluated
        # by any of them, but every matching route still gets its own
        # logged decision saying so — nothing is dropped silently.
        for route in matching:
            gate = gates[route]
            decision = Decision(
                decision_id=new_decision_id(), allowed=False,
                reason=REASON_UNDECODABLE, record_class="undecodable",
                destination=gate.destination, destination_nations=gate.nations,
                label=None, key=key, policy_version=gate.policy_version,
                corpus_version=gate.corpus_version, detail=str(exc),
                route=route.name,
            )
            gate.counts[REASON_UNDECODABLE] = gate.counts.get(REASON_UNDECODABLE, 0) + 1
            EgressGate.log(decision)
    else:
        for route in matching:
            gate = gates[route]
            decision = replace(gate.decide(record, key=key), route=route.name)
            EgressGate.log(decision)
            if decision.allowed:
                # Forwarded byte for byte — see gate.py's module docstring on
                # why the gate decides and never re-encodes.
                producer.produce(route.sink_topic, value=msg.value(), key=msg.key())
                producer.poll(0)

    consumer.commit(msg, asynchronous=False)
    return True
