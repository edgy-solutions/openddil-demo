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

from gate import (  # noqa: E402
    REASON_UNDECODABLE,
    AuthzUnavailable,
    Decision,
    EgressGate,
    new_decision_id,
)

BROKERS = os.getenv("OPENDDIL_EGRESS_BROKERS", "redpanda-hq:19092")
SOURCE_TOPIC = os.getenv("OPENDDIL_EGRESS_SOURCE_TOPIC", "asset-logistics-status")
SINK_TOPIC = os.getenv("OPENDDIL_EGRESS_SINK_TOPIC", "egress-c2-status")
GROUP = os.getenv("OPENDDIL_EGRESS_GROUP", "egress-gate-c2")
DESTINATION = os.getenv("OPENDDIL_EGRESS_DESTINATION", "system:c2-stand-in-atl")
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


def main() -> int:
    from confluent_kafka import Consumer, Producer  # noqa: PLC0415

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    try:
        gate = EgressGate.for_destination(DESTINATION)
    except AuthzUnavailable as exc:
        # Exit rather than start. See the module docstring: a gate that runs
        # with no entitlement is indistinguishable from a gate refusing
        # correctly, and that ambiguity is the operator's whole problem.
        log.error("FATAL: no policy decision for destination %r: %s", DESTINATION, exc)
        return 2

    log.info(
        "gate open: destination=%s nations=%s known=%s policy=%s corpus=%s "
        "%s -> %s",
        gate.destination, list(gate.nations), gate.destination_known,
        gate.policy_version, gate.corpus_version, SOURCE_TOPIC, SINK_TOPIC,
    )

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
    consumer.subscribe([SOURCE_TOPIC])

    seen = 0
    try:
        while _running:
            msg = consumer.poll(POLL_TIMEOUT)
            if msg is None:
                continue
            if msg.error():
                log.warning("consumer error: %s", msg.error())
                continue

            seen += 1
            key = msg.key().decode("utf-8", "replace") if msg.key() else None
            try:
                record = decode(msg.value())
            except Exception as exc:  # noqa: BLE001
                decision = Decision(
                    decision_id=new_decision_id(), allowed=False,
                    reason=REASON_UNDECODABLE, record_class="undecodable",
                    destination=gate.destination,
                    destination_nations=gate.nations, label=None, key=key,
                    policy_version=gate.policy_version,
                    corpus_version=gate.corpus_version, detail=str(exc),
                )
                gate.counts[REASON_UNDECODABLE] = gate.counts.get(REASON_UNDECODABLE, 0) + 1
            else:
                decision = gate.decide(record, key=key)

            EgressGate.log(decision)

            if decision.allowed:
                # Forwarded BYTE FOR BYTE. The gate decides; it does not
                # translate, redact or re-encode. A gate that rewrote the
                # payload would be making a second decision — about what the
                # destination gets to see WITHIN an admitted record — with
                # nothing in the log saying it had.
                producer.produce(SINK_TOPIC, value=msg.value(), key=msg.key())
                producer.poll(0)

            consumer.commit(msg, asynchronous=False)
    finally:
        producer.flush(10)
        consumer.close()
        log.info("gate closed: saw %d records; %s", seen,
                 json.dumps(gate.counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
