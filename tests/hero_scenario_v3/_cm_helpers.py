"""
Helpers for Hero Scenario v3 OSS tests (DIS + cm-service + fusion-rules).

Kafka access uses confluent-kafka directly against the host-mapped OUTSIDE
listener (`localhost:9093` per docker-compose). This replaced the earlier
`docker compose exec ... rpk topic consume` approach, which intermittently
hung on Windows because subprocess.run's timeout did not propagate through
the docker exec pipe. Direct Kafka is faster, has predictable timeouts, and
removes the docker pipe from the critical path.

Customer-feed helpers (proprietary HTTP, sim-a AMQP, battle-mgmt egress,
plus their sample-message builders) live in the customer overlay at
openddil-customer-bundle/tests/_customer_helpers.py — they embed customer
JSON field names and exchange/queue names and are NOT in this OSS file.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from confluent_kafka import Consumer, KafkaError, KafkaException, TopicPartition

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_DIR = REPO_ROOT / "openddil-demo"
REDPANDA_SVC = "redpanda-edge"

# Make the generated protobuf bindings importable from host pytest runs.
# Containers get them via the /proto mount; host tests need this manual
# sys.path injection. Mirrors _protobuf.py's _ensure_proto_path.
_GEN_PYTHON = REPO_ROOT / "openddil-contracts" / "gen" / "python"
if _GEN_PYTHON.is_dir() and str(_GEN_PYTHON) not in sys.path:
    sys.path.insert(0, str(_GEN_PYTHON))

# Host-mapped Redpanda listener (see docker-compose.yml advertise-kafka-addr
# → OUTSIDE://localhost:9093).
KAFKA_BOOTSTRAP = "localhost:9093"

CM_SERVICE_HOST = "http://127.0.0.1:9080"


def docker_compose() -> list[str]:
    return [shutil.which("docker") or "docker", "compose"]


# ---------------------------------------------------------------------------
# Service liveness probes (HTTP, unchanged)
# ---------------------------------------------------------------------------

def cm_service_alive() -> bool:
    """True if cm-service responds on the host-mapped port."""
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"{CM_SERVICE_HOST}/discover",
                                     timeout=2) as resp:
            return resp.status in (200, 405, 415)
    except (urllib.error.URLError, ConnectionError, TimeoutError):
        return False


# ---------------------------------------------------------------------------
# Direct Kafka consume (replaces docker compose exec rpk)
# ---------------------------------------------------------------------------

def _make_consumer(group_suffix: str) -> Consumer:
    """Build a single-use Consumer with a unique group_id so each call
    starts fresh and doesn't share offsets with other test invocations."""
    return Consumer({
        "bootstrap.servers": KAFKA_BOOTSTRAP,
        "group.id":          f"hero-v3-{group_suffix}-{int(time.time()*1000)}",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
        "socket.timeout.ms":  5000,
    })


def consume_topic_recent(topic: str, *, max_records: int = 100,
                          timeout_s: float = 8.0,
                          per_partition_tail: int = 50) -> list[tuple[bytes, bytes]]:
    """Read the last `per_partition_tail` records from each partition of
    `topic`, returning a list of (key_bytes, value_bytes) pairs.

    Bounded by `max_records` total and `timeout_s` wall time. Designed for
    "what was just produced" assertions — does NOT poll for new messages,
    just reads what's already on disk.
    """
    deadline = time.monotonic() + timeout_s
    out: list[tuple[bytes, bytes]] = []
    c = _make_consumer(topic)
    try:
        # Discover partitions and high-water marks
        metadata = c.list_topics(topic=topic, timeout=5)
        if topic not in metadata.topics:
            return []
        partition_ids = list(metadata.topics[topic].partitions.keys())

        assignments: list[TopicPartition] = []
        for p in partition_ids:
            tp = TopicPartition(topic, p)
            low, high = c.get_watermark_offsets(tp, timeout=5)
            if high <= low:
                continue
            start = max(low, high - per_partition_tail)
            assignments.append(TopicPartition(topic, p, start))

        if not assignments:
            return []

        c.assign(assignments)

        while len(out) < max_records and time.monotonic() < deadline:
            msg = c.poll(timeout=0.5)
            if msg is None:
                # No more messages within poll timeout — assume we've
                # drained the recent window and bail.
                # Check if we've passed the high-watermark on every
                # assigned partition.
                positions = c.position(assignments)
                drained = True
                for pos in positions:
                    tp = TopicPartition(topic, pos.partition)
                    _, high = c.get_watermark_offsets(tp, timeout=2)
                    if pos.offset < high:
                        drained = False
                        break
                if drained:
                    break
                continue
            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    continue
                # Other errors — log and move on rather than hanging
                break
            out.append((msg.key() or b"", msg.value() or b""))
    finally:
        c.close()
    return out


def consume_asset_cm_state_for(asset_id: str,
                                timeout_s: int = 15) -> dict | None:
    """Return the latest `asset-cm-state` record for the given canonical
    `asset_id`, or None if not found within the timeout.

    asset-cm-state is compacted and keyed by asset_id, so we filter by
    `record.value["asset_id"]` rather than by Kafka key (cleanup may have
    altered keys on older records during compaction).
    """
    deadline = time.monotonic() + timeout_s
    last_match: dict | None = None
    while time.monotonic() < deadline:
        records = consume_topic_recent("asset-cm-state",
                                        max_records=200,
                                        timeout_s=4.0,
                                        per_partition_tail=50)
        for _key, value in records:
            if not value:
                continue
            try:
                payload = json.loads(value)
            except json.JSONDecodeError:
                continue
            if payload.get("asset_id") == asset_id:
                last_match = payload  # most-recent wins as we iterate
        if last_match is not None:
            return last_match
        time.sleep(0.5)
    return None


def consume_tactical_events(asset_id: str,
                             timeout_s: int = 15) -> list[dict]:
    """Return all CloudEvents on tactical-events whose subject matches
    asset_id, observed within timeout_s."""
    deadline = time.monotonic() + timeout_s
    seen: list[dict] = []
    while time.monotonic() < deadline:
        records = consume_topic_recent("tactical-events",
                                        max_records=200,
                                        timeout_s=4.0,
                                        per_partition_tail=50)
        for _key, value in records:
            if not value:
                continue
            try:
                payload = json.loads(value)
            except json.JSONDecodeError:
                continue
            if payload.get("subject") == asset_id:
                seen.append(payload)
        if seen:
            return seen
        time.sleep(0.5)
    return seen


def count_tactical_events(asset_id: str | None = None) -> int:
    """Count `tactical-events` records (optionally filtered by subject)."""
    records = consume_topic_recent("tactical-events",
                                    max_records=500,
                                    timeout_s=4.0,
                                    per_partition_tail=200)
    if asset_id is None:
        return len(records)
    n = 0
    for _key, value in records:
        try:
            payload = json.loads(value)
            if payload.get("subject") == asset_id:
                n += 1
        except json.JSONDecodeError:
            continue
    return n


# NOTE: customer-feed helpers (proprietary HTTP POST + sim-a AMQP publish +
# their sample message builders) live in the customer overlay at
# openddil-customer-bundle/tests/_customer_helpers.py — they embed customer
# JSON field names and are NOT part of this OSS file.


# ---------------------------------------------------------------------------
# CM event submission via the cli helper inside the cm-service container.
#
# We keep this via `docker compose exec` because the alternative requires
# importing the protobuf bindings on the host AND wiring a Kafka producer.
# CmEvents are infrequent in tests (a few per run) so the docker round-trip
# overhead is acceptable; only the read-heavy Kafka consume hot path was
# moved off docker pipe.
# ---------------------------------------------------------------------------

def submit_cm_event_via_cli(
    asset_id: str,
    *,
    mod_applied: str | None = None,
    inspection: str | None = None,
    timeout_s: int = 20,
) -> int:
    args = [
        "exec", "-T", "cm-service", "python", "/app/cli/submit_cm_event.py",
        "--brokers", "redpanda-edge:9092",
        "--asset-id", asset_id,
    ]
    if mod_applied:
        args += ["--mod-applied", mod_applied]
    elif inspection:
        args += ["--inspection", inspection]
    else:
        raise ValueError("Must specify mod_applied or inspection")
    cmd = docker_compose() + args
    proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                          timeout=timeout_s, text=True)
    return proc.returncode


# ---------------------------------------------------------------------------
# Restate state clear helper (also docker exec — same trade-off as CLI helper)
# ---------------------------------------------------------------------------

def clear_asset_cm_state(asset_id: str, timeout_s: int = 15) -> bool:
    """Wipe the AssetCM Virtual Object's durable state for a single asset_id.
    Useful at test setup time to ensure first-seen semantics.
    """
    cmd = docker_compose() + [
        "exec", "-T", "restate-server",
        "restate", "state", "clear", f"AssetCM/{asset_id}",
        "--force", "--yes",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=timeout_s, text=True)
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def clear_asset_logistics_state(asset_id: str, timeout_s: int = 15) -> bool:
    """Wipe the AssetLogistics Virtual Object's durable state. Required for
    test_25 (lifecycle from is_initial) because Restate state survives Kafka
    topic purge — see Phase 3 bug #9."""
    cmd = docker_compose() + [
        "exec", "-T", "restate-server",
        "restate", "state", "clear", f"AssetLogistics/{asset_id}",
        "--force", "--yes",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=timeout_s, text=True)
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False


# NOTE: RabbitMQ (sim-a ingress + battle-mgmt egress) helpers live in
# openddil-customer-bundle/tests/_customer_helpers.py — they depend on
# customer-specific exchange names and customer-shape sample messages.


# ---------------------------------------------------------------------------
# Phase 3.5: asset-logistics-status Kafka consume helper
# ---------------------------------------------------------------------------

def consume_asset_logistics_updates(
    asset_id: str | None = None,
    *, timeout_s: int = 30,
    max_records: int = 50,
    per_partition_tail: int = 200,
) -> list[dict]:
    """Consume recent records from asset-logistics-status. Decode each into a
    plain dict via the generated AssetLogisticsStatusUpdate proto.

    If `asset_id` is given, filter to that asset. `per_partition_tail`
    defaults to 200 so callers can find the latest emission for a specific
    asset even when the topic is hot with cadenced updates for other assets.
    """
    from openddil.logistics.v1 import logistics_status_pb2 as ls

    records = consume_topic_recent(
        "asset-logistics-status",
        max_records=max_records,
        timeout_s=float(timeout_s),
        per_partition_tail=per_partition_tail,
    )
    out: list[dict] = []
    for key, value in records:
        if not value:
            continue
        try:
            upd = ls.AssetLogisticsStatusUpdate()
            upd.ParseFromString(value)
        except Exception:  # noqa: BLE001
            continue
        if asset_id is not None and upd.status.asset_id != asset_id:
            continue
        out.append({
            "asset_id":          upd.status.asset_id,
            "platform_variant":  upd.status.platform_variant,
            "overall_severity":  ls.LogisticsSeverity.Name(upd.status.overall_severity),
            "is_transition":     upd.is_transition,
            "is_initial":        upd.is_initial,
            "revision":          upd.status.status_revision,
            "factors":           [{
                "factor_id":   f.factor_id,
                "severity":    ls.LogisticsSeverity.Name(f.severity),
                "description": f.description,
            } for f in upd.status.constraining_factors],
        })
    return out
