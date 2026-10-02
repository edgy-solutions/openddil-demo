"""The egress gate, running — ADR-0043 / Arc 2 Slice 2.

Consumes the tier's logistics status, decides each record against ONE
destination, forwards what that destination is entitled to, and records every
decision either way.

WHY A SEPARATE PROCESS AND NOT A FILTER INSIDE THE BRIDGE
Because "the single boundary" has to be somewhere a reader can point at. A
release decision made inside a connector's mapping is a decision distributed
across every connector, and Contract A is explicit that the per-consumer
connector **translates, it does not decide**. This process is where the
deciding happens; whatever carries the result onward is downstream of it and
has no policy in it.

ONE DESTINATION PER PROCESS, ON PURPOSE
A gate serving several destinations from one loop would have to hold several
compiled predicates and would produce a decision log in which "admitted" is
ambiguous until you read the destination field. One process, one link, one
entitlement, one PDP answer for its whole life — which is also what makes
`policy_version` and `corpus_version` fixed facts in every line it writes
rather than moving ones.

FAILURE IS CLOSED AND LOUD
If the PDP cannot be reached at startup the process exits non-zero rather
than starting with no entitlement: a gate that starts and admits nothing
looks exactly like a gate correctly refusing everything, and the difference
is the whole of the operator's diagnosis. If the PDP becomes unreachable
mid-stream the process stops forwarding and exits; it does not fall back to
its last answer, because a stale entitlement is precisely the thing an
entitlement revocation is meant to stop.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from gate import AuthzUnavailable, EgressGate  # noqa: E402
from kinds import load_kinds  # noqa: E402
from routes import GROUP, Route, load_routes, run_once  # noqa: E402

BROKERS = os.getenv("OPENDDIL_EGRESS_BROKERS", "redpanda-hq:19092")
# The route table's own home. When unset there is one route built from the
# legacy env vars — see routes.py's module docstring.
ROUTES_PATH = os.getenv("OPENDDIL_EGRESS_ROUTES_PATH")
# Where kind schemas live, when any route declares one. A deployment with no
# kinds at all (every destination that existed before this pass) need not
# have this directory, and its absence is not an error. Deliberately not
# named `kinds/` next to `kinds.py` — a module and a same-named sibling
# directory on the same path is an import hazard, not just a style choice.
KINDS_DIR = Path(os.getenv(
    "OPENDDIL_EGRESS_KINDS_DIR", str(Path(__file__).parent / "kind-schemas")))
POLL_TIMEOUT = float(os.getenv("OPENDDIL_EGRESS_POLL_TIMEOUT", "1.0"))

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [egress] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("egress")

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s — draining and stopping", signum)
    _running = False


def decode(payload: bytes) -> dict:
    """Read a record into the shape the gate decides on.

    BOTH ENCODINGS ARE REAL ON THIS TOPIC'S LINEAGE and both are accepted —
    protobuf from the fusion service, JSON from producers that carry the
    labels at the top level. A gate that accepted one encoding would refuse
    an entire producer as undecodable, and an undecodable record is NOT a
    denied one: it was never evaluated, and the log must not claim it was.
    """
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception:  # noqa: BLE001 — fall through to proto
        pass

    from google.protobuf.json_format import MessageToDict  # noqa: PLC0415
    from openddil.logistics.v1 import logistics_status_pb2  # noqa: PLC0415

    msg = logistics_status_pb2.AssetLogisticsStatusUpdate()
    msg.ParseFromString(payload)
    # `preserving_proto_field_name` so the labels arrive as
    # `originator_nation` rather than `originatorNation`. The gate reads both
    # spellings anyway; asking for the declared one keeps the decision log's
    # field names the same as the proto's, so a log line and a .proto can be
    # read side by side without a translation step.
    return MessageToDict(msg, preserving_proto_field_name=True)


def _load_known_kinds() -> dict:
    if not KINDS_DIR.is_dir():
        return {}
    return load_kinds(KINDS_DIR)


def _build_gates(routes: list[Route], kinds_map: dict) -> dict[Route, EgressGate]:
    """One gate per route — `for_destination` once each. Any
    `AuthzUnavailable` exits the process rather than starting with a route
    that has no entitlement; see the module docstring."""
    gates: dict[Route, EgressGate] = {}
    for route in routes:
        validator = kinds_map.get(route.kind) if route.kind else None
        gate = EgressGate.for_destination(
            route.destination, kind=route.kind, kind_validator=validator)
        gates[route] = gate
        log.info(
            "gate open: route=%s destination=%s nations=%s known=%s kind=%s "
            "accepts=%s policy=%s corpus=%s registry=%s %s -> %s",
            route.name, gate.destination, list(gate.nations), gate.destination_known,
            gate.kind, list(gate.accepts), gate.policy_version, gate.corpus_version,
            gate.registry_version, route.source_topic, route.sink_topic,
        )
    return gates


def main() -> int:
    from confluent_kafka import Consumer, Producer  # noqa: PLC0415

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    kinds_map = _load_known_kinds()

    try:
        routes = load_routes(ROUTES_PATH, kinds_map.keys())
    except Exception as exc:  # noqa: BLE001 — a bad route table must not start the gate
        log.error("FATAL: route table failed to load: %s", exc)
        return 2

    try:
        gates = _build_gates(routes, kinds_map)
    except AuthzUnavailable as exc:
        # Exit rather than start. See the module docstring: a gate that runs
        # with no entitlement is indistinguishable from a gate refusing
        # correctly, and that ambiguity is the operator's whole problem.
        log.error("FATAL: no policy decision for one or more routes: %s", exc)
        return 2

    routes_by_topic: dict[str, list[Route]] = {}
    for route in routes:
        routes_by_topic.setdefault(route.source_topic, []).append(route)

    consumer = Consumer({
        "bootstrap.servers": BROKERS,
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        # Commit only after the decision is recorded. At-least-once on the
        # decision log is the right direction: a decision logged twice is
        # noise, a decision never logged is a record that crossed unrecorded.
        "enable.auto.commit": False,
    })
    producer = Producer({"bootstrap.servers": BROKERS})
    consumer.subscribe(sorted(routes_by_topic))

    seen = 0
    try:
        while _running:
            if run_once(
                consumer, producer,
                routes_by_topic=routes_by_topic, gates=gates,
                decode=decode, poll_timeout=POLL_TIMEOUT,
            ):
                seen += 1
    finally:
        producer.flush(10)
        consumer.close()
        for route in routes:
            gate = gates[route]
            log.info("gate closed: route=%s; %d records polled total; %s",
                      route.name, seen, json.dumps(gate.counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
