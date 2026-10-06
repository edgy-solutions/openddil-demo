"""
Shared helpers for Hero Scenario v3 tests.

Design goals:
  - No external dependencies beyond Python stdlib (uses urllib + subprocess).
  - Tests run from the host machine; Kafka access is via `docker compose exec`
    against `redpanda-edge`, which is more reliable than relying on the host's
    9093 OUTSIDE listener.
  - UDP traffic goes to localhost:62040 (mapped to the sidecar container).
  - Prometheus metrics scraped from http://localhost:8081/metrics (the
    sidecar's container :8080 mapped to host :8081 to avoid colliding with
    Restate's :8080).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
REPO_ROOT       = Path(__file__).resolve().parents[3]
COMPOSE_DIR     = REPO_ROOT / "openddil-demo"
FIXTURES_DIR    = REPO_ROOT / "openddil-sensor-ingest" / "fixtures"

UDP_HOST        = "127.0.0.1"
UDP_PORT        = 62040
METRICS_URL     = "http://127.0.0.1:8081/metrics"
HTTP_DIAG_URL   = "http://127.0.0.1:9999/"

TOPIC_BRONZE    = "ingress-dis-raw"
TOPIC_SILVER    = "raw-sensor-stream"
TOPIC_DLQ       = "ingress-dlq"
TOPIC_EFFECTOR  = "effector-events"

# Redpanda Connect's own Prometheus endpoint. It is NOT published to the host
# in docker-compose (only the diagnostic 9999 is), so it is scraped by shelling
# into the container the same way topic_high_watermark shells in for rpk.
CONNECT_SVC          = "redpanda-connect-01"
CONNECT_METRICS_PORT = 4196

# ADR-0023 Phase 6a: 3-edge topology. Default rpk targets edge-01 broker
# (existing tests 35-39 are pinned to edge-01 by convention); multi-edge
# tests address brokers and sensor containers via edge_id with the
# port_for_edge / container_for_edge / broker_svc_for_edge helpers below.
REDPANDA_SVC    = "redpanda-edge-01"
SENSOR_SVC      = "openddil-sensor-ingest-01"

# Per-edge port and container mapping (matches docker-compose.yml).
EDGE_UDP_PORT = {
    "edge-01": 62040,
    "edge-02": 62041,
    "edge-03": 62042,
}
EDGE_SENSOR_CONTAINER = {
    "edge-01": "openddil-demo-sensor-ingest-01",
    "edge-02": "openddil-demo-sensor-ingest-02",
    "edge-03": "openddil-demo-sensor-ingest-03",
}
EDGE_BROKER_SVC = {
    "edge-01": "redpanda-edge-01",
    "edge-02": "redpanda-edge-02",
    "edge-03": "redpanda-edge-03",
}


def port_for_edge(edge_id: str) -> int:
    """Map an edge_id to its sensor-ingest's host UDP port."""
    if edge_id not in EDGE_UDP_PORT:
        raise ValueError(f"unknown edge_id {edge_id!r}; known: {list(EDGE_UDP_PORT)}")
    return EDGE_UDP_PORT[edge_id]


def container_for_edge(edge_id: str) -> str:
    """Map an edge_id to its sensor-ingest container name (for socat send)."""
    if edge_id not in EDGE_SENSOR_CONTAINER:
        raise ValueError(f"unknown edge_id {edge_id!r}; known: {list(EDGE_SENSOR_CONTAINER)}")
    return EDGE_SENSOR_CONTAINER[edge_id]


def broker_svc_for_edge(edge_id: str) -> str:
    """Map an edge_id to its Kafka broker compose service name."""
    if edge_id not in EDGE_BROKER_SVC:
        raise ValueError(f"unknown edge_id {edge_id!r}; known: {list(EDGE_BROKER_SVC)}")
    return EDGE_BROKER_SVC[edge_id]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def pass_(test_name: str, detail: str = "") -> None:
    msg = f"PASS: {test_name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    sys.exit(0)


def fail_(test_name: str, detail: str) -> None:
    print(f"FAIL: {test_name} — {detail}")
    sys.exit(1)


def skip_(test_name: str, detail: str) -> None:
    print(f"SKIP: {test_name} — {detail}")
    sys.exit(0)


# ---------------------------------------------------------------------------
# UDP send
# ---------------------------------------------------------------------------
_DOCKER_NETWORK   = "openddil-demo_default"


def send_udp_bytes(data: bytes, host: str = UDP_HOST, port: int = UDP_PORT,
                   edge_id: str | None = None) -> None:
    """
    Windows Docker Desktop has a long-standing 'UDP black hole' when sending
    from the host to a container's mapped UDP port. We dodge it by running a
    one-shot socat container on the same Docker network that pipes the bytes
    in via stdin and UDP-sends them to the sidecar by service hostname.

    ADR-0023 Phase 6a: pass `edge_id="edge-NN"` to route to that edge's
    sensor-ingest container + UDP port. Default routes to edge-01 (port
    62040) so existing 35-39 tests work unchanged.
    """
    if edge_id is None:
        target_container = container_for_edge("edge-01")
        target_port = port if port != UDP_PORT else port_for_edge("edge-01")
    else:
        target_container = container_for_edge(edge_id)
        target_port = port_for_edge(edge_id)

    docker = shutil.which("docker") or "docker"
    target = f"{target_container}:{target_port}"
    proc = subprocess.run(
        [docker, "run", "--rm", "-i",
         "--network", _DOCKER_NETWORK,
         "alpine/socat",
         "-u", "STDIN", f"UDP4-SENDTO:{target}"],
        input=data, capture_output=True, timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"socat send failed (exit={proc.returncode}): "
            f"{proc.stderr.decode(errors='replace')}"
        )


def query_postgres(sql: str, *, timeout_s: int = 15) -> list[list[str]]:
    """Run a SQL query against postgres-hq via `docker compose exec` and
    return rows as lists of stringified column values (tab-separated parse).
    Tests use this to verify projector-written read-model state.
    """
    cmd = _docker_compose_cmd() + [
        "exec", "-T", "postgres-hq",
        "psql", "-U", "postgres", "-d", "openddil",
        "-At", "-F", "|",  # unaligned, tuples-only, pipe-separated columns
        "-c", sql,
    ]
    proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                          timeout=timeout_s, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"postgres query failed (exit={proc.returncode}): {proc.stderr.strip()}"
        )
    rows = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(line.split("|"))
    return rows


def send_fixture(name: str) -> bytes:
    path = FIXTURES_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Fixture not found: {path}")
    data = path.read_bytes()
    send_udp_bytes(data)
    return data


def send_http(payload: dict) -> int:
    """POST JSON to the diagnostic HTTP path on :9999. Returns HTTP status."""
    body = json.dumps(payload).encode()
    req = urllib.request.Request(HTTP_DIAG_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.getcode()
    except urllib.error.HTTPError as e:
        return e.code


# ---------------------------------------------------------------------------
# DIS PDU synthesis (Entity State PDU, IEEE 1278.1)
# ---------------------------------------------------------------------------
def build_remove_entity_pdu(site: int = 1, application: int = 1,
                            entity: int = 4773) -> bytes:
    """A Remove Entity PDU (type 12, family 5) for site/application/entity.

    Same layout dis_sim.py sends through Open-DIS: the originator is the
    sim's own site/application with entity 0, the receiving id is the entity
    being removed, request id 0. 28 bytes: header 12, two entity ids, 4.
    """
    buf = bytearray()
    buf += struct.pack(">BBBBIHBB", 7, 1, 12, 5, 0, 28, 0, 0)
    buf += struct.pack(">HHH", site, application, 0)
    buf += struct.pack(">HHH", site, application, entity)
    buf += struct.pack(">I", 0)
    return bytes(buf)


def build_entity_state_pdu(
    site: int = 1,
    application: int = 1,
    entity: int = 4773,
    kind: int = 1,
    domain: int = 1,
    country: int = 225,
    category: int = 1,
    subcategory: int = 1,
    specific: int = 18,
    extra: int = 0,
    force_id: int = 1,
    marking: str = "TEST-01",
    location_ecef: tuple[float, float, float] = (0.0, 0.0, 0.0),
    orientation_psi_theta_phi: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bytes:
    """
    Hand-roll a minimal v7 Entity State PDU compatible with what
    opendis.PduFactory.createPdu() expects.

    Layout (header + minimum body, no articulation params):
      Byte  0:   protocolVersion (7)
      Byte  1:   exerciseID (1)
      Byte  2:   pduType (1 = Entity State)
      Byte  3:   protocolFamily (1 = Entity Information/Interaction)
      Bytes 4-7: timestamp (uint32)
      Bytes 8-9: length (uint16 — we leave 0; opendis tolerates)
      Byte 10:   pduStatus (0)
      Byte 11:   padding (0)
      Bytes 12-17: EntityID (site, application, entity — three uint16)
      Bytes 18-19: forceId + numberOfArticulationParameters (uint8 each)
      Bytes 20-26: EntityType (kind, domain, country uint16, category, subcat,
                                specific, extra — each uint8 except country)
                  Actual order: kind(u8) domain(u8) country(u16) category(u8)
                                 subcategory(u8) specific(u8) extra(u8)
      Bytes 27-32: AlternativeEntityType (same shape) — zero-fill
      Bytes 33-44: EntityLinearVelocity (3 floats)
      Bytes 45-68: EntityLocation (3 doubles)
      Bytes 69-80: EntityOrientation (3 floats: psi, theta, phi)
      Bytes 81-84: EntityAppearance (uint32)
      Bytes 85-99: DeadReckoningParameters (algo u8 + other params + linear
                                              acceleration + angular velocity)
      Bytes 100-111: EntityMarking (charset u8 + 11 chars)
      Bytes 112-115: EntityCapabilities (uint32)

    This builder targets the on-the-wire layout opendis 1.0 parses. It is the
    same approach used to generate the static `sample_entity_state.bin`
    fixture; we only re-build dynamically to vary the entity-type triplet.
    """
    buf = bytearray()
    # Header (12 bytes)
    buf += struct.pack(">BBBBIHBB",
        7,    # protocolVersion
        1,    # exerciseID
        1,    # pduType (Entity State)
        1,    # protocolFamily
        0,    # timestamp
        144,  # length
        0,    # pduStatus
        0,    # padding
    )
    # EntityID (6 bytes)
    buf += struct.pack(">HHH", site, application, entity)
    # forceId + numArticulationParams
    buf += struct.pack(">BB", force_id, 0)
    # EntityType (8 bytes: kind, domain, country[u16], category, subcat, specific, extra)
    buf += struct.pack(">BBHBBBB", kind, domain, country, category,
                       subcategory, specific, extra)
    # AlternativeEntityType (zero-filled, 8 bytes)
    buf += b"\x00" * 8
    # EntityLinearVelocity (3 floats = 12 bytes)
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)
    # EntityLocation (3 doubles = 24 bytes) — ECEF metres
    buf += struct.pack(">ddd", *location_ecef)
    # EntityOrientation (3 floats = 12 bytes) — psi, theta, phi in radians
    buf += struct.pack(">fff", *orientation_psi_theta_phi)
    # EntityAppearance (4 bytes)
    buf += struct.pack(">I", 0)
    # DeadReckoningParameters (40 bytes total: algo + 15 params + 3f + 3f)
    buf += b"\x01"                  # deadReckoningAlgorithm = 1 (static)
    buf += b"\x00" * 15             # otherParameters
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)  # linearAcceleration
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)  # angularVelocity
    # EntityMarking (12 bytes: charset u8 + 11 char string)
    marking_chars = marking.encode("ascii")[:11].ljust(11, b"\x00")
    buf += b"\x01" + marking_chars
    # EntityCapabilities (4 bytes)
    buf += struct.pack(">I", 0)
    return bytes(buf)


def _pack_entity_id_or_zero(site: int, application: int,
                            entity: int | None) -> bytes:
    """Pack an EntityID triple, or the DIS wildcard-unassigned (0,0,0) when
    `entity` is None -- the sentinel dis_ingestor._entity_urn_or_none()
    reads as "field not present" (see its own docstring)."""
    if entity is None:
        return struct.pack(">HHH", 0, 0, 0)
    return struct.pack(">HHH", site, application, entity)


def build_fire_pdu(
    site: int = 1,
    application: int = 1,
    event_number: int = 1,
    firing_entity: int = 57001,
    target_entity: int | None = 57010,
    munition_entity: int = 0,
    munition_type: tuple[int, int, int, int, int, int, int] = (2, 0, 0, 0, 0, 0, 0),
    warhead: int = 0,
    fuse: int = 0,
    quantity: int = 1,
    rate: int = 0,
    range_: float = 0.0,
    location_ecef: tuple[float, float, float] = (0.0, 0.0, 0.0),
    velocity: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bytes:
    """
    Hand-roll a Fire PDU (type 2, Warfare family, Section 7.3.2) compatible
    with what opendis.PduFactory.createPdu() expects, mirroring
    build_entity_state_pdu's approach (no opendis dependency at
    construction time).

    Layout (96 bytes total):
      Header (12):            as build_entity_state_pdu, pduType=2,
                               protocolFamily=2 (Warfare).
      firingEntityID (6):     site, application, firing_entity.
      targetEntityID (6):     site, application, target_entity, or the
                               (0,0,0) wildcard when target_entity is None
                               (a Fire with no declared target).
      munitionExpendableID (6): site, application, munition_entity.
      eventID (6):            site, application, event_number -- the same
                               triple a paired Detonation PDU must repeat
                               to be recognised as the same engagement.
      fireMissionIndex (4):   uint32, always 0 here.
      location (24):          3 doubles, ECEF metres.
      descriptor (16):        MunitionDescriptor -- munitionType (8: kind,
                               domain, country u16, category, subcategory,
                               specific, extra) + warhead/fuse/quantity/rate
                               (4 x u16).
      velocity (12):          3 floats.
      range (4):              float32.
    """
    buf = bytearray()
    buf += struct.pack(">BBBBIHBB", 7, 1, 2, 2, 0, 96, 0, 0)
    buf += struct.pack(">HHH", site, application, firing_entity)
    buf += _pack_entity_id_or_zero(site, application, target_entity)
    buf += struct.pack(">HHH", site, application, munition_entity)
    buf += struct.pack(">HHH", site, application, event_number)
    buf += struct.pack(">I", 0)
    buf += struct.pack(">ddd", *location_ecef)
    kind, domain, country, category, subcategory, specific, extra = munition_type
    buf += struct.pack(">BBHBBBB", kind, domain, country, category,
                       subcategory, specific, extra)
    buf += struct.pack(">HHHH", warhead, fuse, quantity, rate)
    buf += struct.pack(">fff", *velocity)
    buf += struct.pack(">f", range_)
    return bytes(buf)


def build_detonation_pdu(
    site: int = 1,
    application: int = 1,
    event_number: int = 1,
    firing_entity: int = 57001,
    target_entity: int | None = 57010,
    munition_entity: int = 0,
    munition_type: tuple[int, int, int, int, int, int, int] = (2, 0, 0, 0, 0, 0, 0),
    warhead: int = 0,
    fuse: int = 0,
    quantity: int = 1,
    rate: int = 0,
    detonation_result: int = 1,
    location_ecef: tuple[float, float, float] = (0.0, 0.0, 0.0),
    velocity: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bytes:
    """
    Hand-roll a Detonation PDU (type 3, Warfare family, Section 7.3.3),
    same approach as build_fire_pdu. Pass the same event_number,
    firing_entity and target_entity as the Fire PDU it terminates, so both
    carry the same event_urn/launcher_urn/target_urn on ingest.

    Layout (104 bytes total):
      Header (12):            pduType=3, protocolFamily=2 (Warfare).
      firingEntityID (6), targetEntityID (6): as build_fire_pdu.
      explodingEntityID (6):  site, application, munition_entity.
      eventID (6):            site, application, event_number.
      velocity (12):          3 floats.
      location (24):          3 doubles.
      descriptor (16):        MunitionDescriptor, as build_fire_pdu.
      locationInEntityCoordinates (12): 3 floats, always 0 here.
      detonationResult (1):   uint8 DIS enum (UID 62) -- carried opaque.
      numberOfVariableParameters (1): uint8, always 0 here.
      pad (2):                uint16, always 0.
    """
    buf = bytearray()
    buf += struct.pack(">BBBBIHBB", 7, 1, 3, 2, 0, 104, 0, 0)
    buf += struct.pack(">HHH", site, application, firing_entity)
    buf += _pack_entity_id_or_zero(site, application, target_entity)
    buf += struct.pack(">HHH", site, application, munition_entity)
    buf += struct.pack(">HHH", site, application, event_number)
    buf += struct.pack(">fff", *velocity)
    buf += struct.pack(">ddd", *location_ecef)
    kind, domain, country, category, subcategory, specific, extra = munition_type
    buf += struct.pack(">BBHBBBB", kind, domain, country, category,
                       subcategory, specific, extra)
    buf += struct.pack(">HHHH", warhead, fuse, quantity, rate)
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)
    buf += struct.pack(">BB", detonation_result, 0)
    buf += struct.pack(">H", 0)
    return bytes(buf)


# ---------------------------------------------------------------------------
# Kafka consume via `docker compose exec`
# ---------------------------------------------------------------------------
def _docker_compose_cmd() -> list[str]:
    docker = shutil.which("docker") or "docker"
    return [docker, "compose"]


def consume_topic(topic: str, n: int, timeout_s: int = 15,
                  offset: str = "start") -> list[dict | bytes]:
    """
    Consume `n` messages from `topic` using `rpk topic consume` inside the
    redpanda-edge container. Default `rpk` output is line-delimited JSON
    records of the form {"topic":..., "key":..., "value":"<string>", ...}.

    For Kafka topics with JSON payloads (e.g. ingress-dis-raw), each returned
    list element is the parsed-JSON value. For binary payloads (e.g. protobuf
    on raw-sensor-stream), use `consume_topic_records()` to get the wrapper
    record (including base64-decoded bytes via `.value_bytes`).

    `offset`:
      - "end"   = read only newly produced messages (default)
      - "start" = read from earliest
    """
    records = consume_topic_records(topic, n, timeout_s, offset)
    out: list = []
    for rec in records:
        v = rec.get("value")
        if v is None:
            continue
        if isinstance(v, (dict, list)):
            out.append(v)
            continue
        # rpk returns value as a string; try JSON first, fall back to bytes
        try:
            out.append(json.loads(v))
        except (json.JSONDecodeError, TypeError):
            if isinstance(v, str):
                out.append(v.encode("utf-8", errors="replace"))
            else:
                out.append(v)
    return out


def consume_topic_records(topic: str, n: int, timeout_s: int = 15,
                           offset: str = "start") -> list[dict]:
    """
    Like `consume_topic` but returns the full wrapper records from rpk.
    Reads the last N records from each partition individually so we never
    block waiting for records that don't exist — which it now actually does,
    by clamping to LOG-START-OFFSET and reading an explicit offset range.
    See `_partition_offsets` for the hang this sentence used to describe
    rather than prevent. `offset` is accepted for backward compatibility and
    is IGNORED; every caller passing `offset="-10"` or `offset="start"` gets
    identical behaviour, so do not read a caller's value as intent.
    """
    records: list[dict] = []
    deadline = time.monotonic() + timeout_s

    for partition, (log_start, hw) in _partition_offsets(topic).items():
        if hw <= log_start:
            continue
        if time.monotonic() >= deadline:
            break
        # Clamp to what the log still holds, then ask for an explicit RANGE.
        # `-o start:end` exits on its own at `end`; `-n count` waits for a
        # count and hangs when retention has removed the difference.
        start_offset = max(log_start, hw - n)
        remaining = max(1, int(deadline - time.monotonic()))
        cmd = _docker_compose_cmd() + [
            "exec", "-T", REDPANDA_SVC,
            "rpk", "topic", "consume", topic,
            "-p", str(partition),
            "-o", f"{start_offset}:{hw}",
        ]
        try:
            proc = subprocess.run(
                cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                timeout=remaining, text=True,
            )
        except subprocess.TimeoutExpired:
            continue

        # rpk default JSON output streams one record-object per JSON document.
        # When pretty-printed across multiple lines, accumulate braces.
        buf: list[str] = []
        depth = 0
        for ch in proc.stdout:
            buf.append(ch)
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    blob = "".join(buf).strip()
                    buf = []
                    if not blob:
                        continue
                    try:
                        records.append(json.loads(blob))
                    except json.JSONDecodeError:
                        pass
    return records


def consume_topic_records_range(topic: str, start_offsets: dict[int, int],
                                  end_offsets: dict[int, int],
                                  timeout_s: int = 15) -> list[dict]:
    """
    Like `consume_topic_records`, but reads the EXACT caller-supplied
    [start, end) offset range per partition instead of "the last N per
    partition" -- for callers that already know the precise range a single
    run wrote (e.g. from `partition_high_watermarks` taken before and after
    sending a fixture) and must not pick up any other run's records, even
    ones with byte-identical content. Does not touch `consume_topic_records`
    or its "last N" behaviour; that function is unchanged and still used by
    every caller that only wants a recent-window read.
    """
    records: list[dict] = []
    deadline = time.monotonic() + timeout_s

    partitions = sorted(set(start_offsets) | set(end_offsets))
    for partition in partitions:
        start_offset = start_offsets.get(partition)
        end_offset = end_offsets.get(partition)
        if start_offset is None or end_offset is None:
            continue
        if end_offset <= start_offset:
            continue
        if time.monotonic() >= deadline:
            break
        remaining = max(1, int(deadline - time.monotonic()))
        cmd = _docker_compose_cmd() + [
            "exec", "-T", REDPANDA_SVC,
            "rpk", "topic", "consume", topic,
            "-p", str(partition),
            "-o", f"{start_offset}:{end_offset}",
        ]
        try:
            proc = subprocess.run(
                cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                timeout=remaining, text=True,
            )
        except subprocess.TimeoutExpired:
            continue

        buf: list[str] = []
        depth = 0
        for ch in proc.stdout:
            buf.append(ch)
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    blob = "".join(buf).strip()
                    buf = []
                    if not blob:
                        continue
                    try:
                        records.append(json.loads(blob))
                    except json.JSONDecodeError:
                        pass
    return records


def value_bytes_from_record(rec: dict) -> bytes:
    """
    rpk emits `value` as a raw string (UTF-8 of the bytes). For binary
    Kafka payloads (protobuf), use `--format=%v` mode separately when bytes
    must be preserved exactly. This helper is a best-effort decoder for
    the JSON-record path: it round-trips the string through latin-1 to
    preserve byte values 0..255.
    """
    v = rec.get("value", "")
    if isinstance(v, bytes):
        return v
    if isinstance(v, str):
        return v.encode("latin-1", errors="replace")
    return b""


def consume_topic_binary(topic: str, n: int, timeout_s: int = 15,
                          offset: str = "start") -> list[bytes]:
    """
    Consume binary records and return raw bytes per record.

    `n` is interpreted as "up to N most recent records per partition", where
    "available" means at or above LOG-START-OFFSET, not at or above 0. We
    iterate partitions individually and read an explicit offset range, so
    each `rpk` invocation exits on its own; rpk has no global timeout flag
    and WILL hang if asked via `-n` for more records than exist, and the
    Python-side `timeout` does not save us (see `_partition_offsets`).

    `offset` is accepted for backward compatibility and is IGNORED.
    """
    delim = b"<<HERO_V3_DELIM>>"
    out: list[bytes] = []
    deadline = time.monotonic() + timeout_s

    for partition, (log_start, hw) in _partition_offsets(topic).items():
        if hw <= log_start:
            continue
        if time.monotonic() >= deadline:
            break
        # Clamp to what the log still holds, then ask for an explicit RANGE.
        # `-o start:end` exits on its own at `end`; `-n count` waits for a
        # count and hangs when retention has removed the difference.
        start_offset = max(log_start, hw - n)
        remaining = max(1, int(deadline - time.monotonic()))
        cmd = _docker_compose_cmd() + [
            "exec", "-T", REDPANDA_SVC,
            "rpk", "topic", "consume", topic,
            "-p", str(partition),
            "-o", f"{start_offset}:{hw}",
            f"--format=%v{delim.decode()}",
        ]
        try:
            proc = subprocess.run(
                cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                timeout=remaining,
            )
        except subprocess.TimeoutExpired:
            continue
        raw = proc.stdout or b""
        for part in raw.split(delim):
            if part:
                out.append(part)
    return out


def _partition_offsets(topic: str) -> dict[int, tuple[int, int]]:
    """
    Map partition_id -> (log_start_offset, high_watermark).

    BOTH BOUNDS, AND THAT IS THE POINT (2026-09-27). This used to return the
    high-watermark alone, and both consumers then computed `start = hw - n`
    and passed `-n n`. That arithmetic assumes offset 0 is still readable. It
    is not: `raw-sensor-stream` carries `retention.ms=86400000`, so on any
    stack older than a day the log start has advanced and `hw - n` can point
    BELOW it. rpk then delivers the records that exist and BLOCKS FOREVER
    waiting for the rest, because `-n` is a count to wait for, not a limit.

    Measured on compose: LOG-START-OFFSET 202, HIGH-WATERMARK 211 — nine
    records. `consume_topic_binary(n=80)` asked from 131 for 80 and hung past
    110s against its own `timeout_s=20`, because `subprocess.run(timeout=)`
    kills `docker compose` but not the `rpk` grandchild holding the pipe, so
    the reap that follows has no timeout at all. A test that hangs is worse
    than one that fails: `run_all.py` has no per-test timeout, so one wedged
    test wedges the whole suite and reports nothing about anything.
    """
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC,
        "rpk", "topic", "describe", topic, "--print-partitions",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return {}
    result: dict[int, tuple[int, int]] = {}
    for line in proc.stdout.splitlines():
        # PARTITION LEADER EPOCH REPLICAS LOG-START-OFFSET HIGH-WATERMARK.
        # Index the two offsets from the RIGHT: REPLICAS prints as one header
        # column but N tokens (`[0]` at RF=1, `[0 1 2]` at RF=3), so any
        # left-anchored pattern breaks the moment replication changes.
        m = re.match(r"\s*(\d+)\s", line)
        if not m:
            continue
        toks = line.split()
        if len(toks) < 2:
            continue
        try:
            log_start, hw = int(toks[-2]), int(toks[-1])
        except ValueError:
            continue
        result[int(m.group(1))] = (log_start, hw)
    return result


def partition_high_watermarks(topic: str) -> dict[int, int]:
    """
    Map partition_id -> high_watermark only, for callers that need an exact
    "everything written up to right now" snapshot rather than the
    (log_start, hw) pair `_partition_offsets` returns. Taken immediately
    before and after sending a fixture, the two snapshots bound exactly the
    records THIS run produced -- not "the last N per partition", which
    cannot distinguish this run's records from an earlier run's identical
    ones on a topic nothing ever resets.
    """
    return {p: hw for p, (_log_start, hw) in _partition_offsets(topic).items()}


def topic_high_watermark(topic: str) -> int | None:
    """Return the total message count across all partitions, or None on error.

    READS THE HEADER RATHER THAN COUNTING COLUMNS (fixed 2026-09-27). This
    function used to match

        r"\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s+"

    which assumes the columns are PARTITION LEADER EPOCH HIGH-WATERMARK. The
    rpk in use prints

        PARTITION  LEADER  EPOCH  REPLICAS  LOG-START-OFFSET  HIGH-WATERMARK

    and `[0]` is not `\d+`, so the pattern matched NO line and the function
    returned 0 for every topic -- never None, so no caller could tell. Both
    callers used it as `topic_high_watermark(t) or 0` to assert "nothing new
    landed", which made those assertions `0 > 0`: permanently false, and
    therefore permanently passing. A check that cannot fail is not a check.

    The column is located by NAME from the header, and indexed FROM THE RIGHT.
    Indexing from the left would reintroduce the same class of bug the moment a
    topic has RF>1, because rpk prints replicas as `[0 1 2]` -- one header
    column, three whitespace-separated tokens. HIGH-WATERMARK sits to the right
    of REPLICAS, so counting from the end steps over that hazard entirely.
    """
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC,
        "rpk", "topic", "describe", topic, "--print-partitions",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return None

    lines = proc.stdout.splitlines()
    from_end = None
    for line in lines:
        cols = line.split()
        if "HIGH-WATERMARK" in cols:
            from_end = len(cols) - cols.index("HIGH-WATERMARK")
            break
    if from_end is None:
        # No header: the topic does not exist, rpk errored, or the output shape
        # changed again. None, not 0 -- so a caller that cares can tell.
        return None

    # A missing topic is NOT zero messages. rpk prints the header and no data
    # rows for a topic that does not exist, so summing to 0 would make
    # "absent" and "present but empty" the same answer -- which is the
    # ambiguity this whole function was just fixed for. A topic that exists
    # always reports at least one partition, so seeing no partition row at all
    # is the error case.
    total = 0
    rows = 0
    for line in lines:
        cols = line.split()
        if len(cols) < from_end or "HIGH-WATERMARK" in cols:
            continue
        tok = cols[-from_end]
        if tok.isdigit():
            total += int(tok)
            rows += 1
    return total if rows else None


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------
def scrape_metrics(url: str = METRICS_URL, timeout_s: int = 5) -> str:
    with urllib.request.urlopen(url, timeout=timeout_s) as resp:
        return resp.read().decode()


def scrape_connect_metrics(service: str = CONNECT_SVC,
                          timeout_s: int = 10) -> str:
    """Scrape Redpanda Connect's /metrics from inside the container.

    Connect exposes Prometheus on its http port by default -- there is no
    `metrics:` block in openddil-base-connect.yaml and none is needed. The port
    is not mapped to the host, so this goes through `docker compose exec`
    rather than urllib. Returns "" on any failure, so a caller can tell
    "endpoint unreachable" from "series absent" only if it checks for empty.
    """
    cmd = _docker_compose_cmd() + [
        "exec", "-T", service,
        "wget", "-qO-", f"http://localhost:{CONNECT_METRICS_PORT}/metrics",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=timeout_s, text=True)
    except subprocess.TimeoutExpired:
        return ""
    return proc.stdout


def scrape_service_metrics(service: str, port: int,
                           timeout_s: int = 10) -> str:
    """Scrape a Python service's prometheus_client endpoint from inside its
    container. The projector and the Restate services do not publish their
    metrics ports to the host, and their images carry python but not wget.
    Returns "" on any failure, as scrape_connect_metrics does.
    """
    script = ("import urllib.request;print(urllib.request.urlopen("
              f"'http://localhost:{port}/metrics',timeout=5).read().decode())")
    cmd = _docker_compose_cmd() + [
        "exec", "-T", service, "python", "-c", script,
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=timeout_s, text=True)
    except subprocess.TimeoutExpired:
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def metric_sum(text: str, name: str) -> float | None:
    """Sum every series of `name`, labelled or not. None if there is no
    series at all, so "never registered" is not read as "zero"."""
    pattern = re.compile(
        r"^" + re.escape(name) + r"(?:\{[^}]*\})?\s+([0-9eE+\-.]+)$",
        re.MULTILINE,
    )
    vals = [float(v) for v in pattern.findall(text)]
    return sum(vals) if vals else None


def metric_value_labeled(text: str, name: str,
                         labels: dict | None = None) -> float:
    """Like metric_value, but matches a SUBSET of the labels present.

    metric_value builds the label block as an exact string, which cannot match
    a Redpanda Connect metric: Connect appends its own `label` and `path`
    labels to every series a `metric` processor emits, e.g.

      dis_ingress_kind_dropped{kind="2",label="",path="root.processor_..."} 1

    so requiring an exact set would silently return 0.0 and read as "nothing
    was dropped" -- the exact failure mode the counter exists to prevent.
    Returns 0.0 if not found.
    """
    lookaheads = ""
    for k, v in (labels or {}).items():
        lookaheads += r"(?=[^}]*" + re.escape(f'{k}="{v}"') + ")"
    pattern = re.compile(
        r"^" + re.escape(name) + r"\{" + lookaheads + r"[^}]*\}\s+([0-9eE+\-.]+)$",
        re.MULTILINE,
    )
    m = pattern.search(text)
    return float(m.group(1)) if m else 0.0


def metric_value(text: str, name: str, labels: dict | None = None) -> float:
    """
    Parse a single counter value from /metrics text.
    `name` is the bare metric name (without _total suffix-handling).
    `labels` is a dict of label=value to require an exact match.
    Returns 0.0 if not found.
    """
    label_str = ""
    if labels:
        parts = [f'{k}="{v}"' for k, v in labels.items()]
        label_str = "{" + ",".join(parts) + "}"

    pattern = re.compile(
        r"^" + re.escape(name) + re.escape(label_str) + r"\s+([0-9eE+\-.]+)$",
        re.MULTILINE,
    )
    m = pattern.search(text)
    if m:
        return float(m.group(1))

    # Fallback: match any labels containing all required label=value pairs
    if labels:
        any_pat = re.compile(
            r"^" + re.escape(name) + r"\{([^}]*)\}\s+([0-9eE+\-.]+)$",
            re.MULTILINE,
        )
        for lbls, val in any_pat.findall(text):
            ok = all(f'{k}="{v}"' in lbls for k, v in labels.items())
            if ok:
                return float(val)
    return 0.0


# ---------------------------------------------------------------------------
# Container liveness
# ---------------------------------------------------------------------------
def sensor_alive() -> bool:
    cmd = _docker_compose_cmd() + ["ps", "--status=running",
                                    "--services"]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return False
    return SENSOR_SVC in proc.stdout.split()


# ---------------------------------------------------------------------------
# Readiness-gate principle (Phase 5 lesson — applies any time a test asks
# "is this engine running?"):
#   Gate on a signal that is true AT ENGINE STARTUP, NOT on a signal that
#   only becomes true after the engine has done its job. Output-existence
#   ("does the output topic have records?") is a result, not a readiness,
#   signal — it skips the test before the engine can produce. Reliable
#   startup-time signals: consumer-group membership Stable, changelog-topic
#   creation (Faust creates these at Table init), container `running`
#   status, an HTTP health endpoint. test_35 had a chicken-and-egg gate on
#   `derived-sustainment` existing; fixed by keying on the engine's
#   changelog topic instead. `wait_for_pipeline_ready` below is the
#   canonical pattern — keys on consumer groups being Stable.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Pipeline warm-up gate
# ---------------------------------------------------------------------------
# Consumer groups the OSS hero-scenario tests depend on. Until each is present
# and Stable on redpanda-edge, a freshly-`up`'d stack drops or mis-orders the
# first events a test sends — the flaky-test class seen in Phase 3.6, where a
# test would send a PDU before connect-dis-mapper had finished joining its
# group and then time out waiting for a Silver record that was never consumed.
#
#   connect-dis-mapper    redpanda-connect: ingress-dis-raw -> raw-sensor-stream
#   cm-service-silver     cm-service Restate sub: raw-sensor-stream -> AssetCM
#   cm-service-cm-events  cm-service Restate sub: cm-events        -> AssetCM
#   fusion-service-derived  logistics-fusion Restate sub: derived-sustainment
#                           -> AssetLogistics (Phase 5 step 2; needed for the
#                           cross-tying integration test which drives DIS-only
#                           assets through to logistics-status — without this
#                           subscription Stable, the integration test would
#                           race fusion's startup)
#
# logistics-fusion's other groups (fusion-service-windows, -cm-state, -silver)
# are intentionally NOT gated here: the OSS runner never drives them — they
# need the sim-a / proprietary feeds that live in the customer overlay.
_REQUIRED_GROUPS = (
    "connect-dis-mapper",
    "cm-service-silver",
    "cm-service-cm-events",
    "fusion-service-derived",
)


def _consumer_group_state(group: str) -> str | None:
    """
    Return the Kafka consumer-group state for `group` as reported by
    `rpk group describe` (e.g. "Stable", "Empty", "PreparingRebalance"),
    or None if the group does not exist yet or rpk errored.
    """
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC,
        "rpk", "group", "describe", group,
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        m = re.match(r"\s*STATE\s+(\S+)", line)
        if m:
            return m.group(1)
    return None


def wait_for_pipeline_ready(timeout_s: int = 120,
                            groups: tuple[str, ...] = _REQUIRED_GROUPS) -> bool:
    """
    Block until every consumer group in `groups` is present and Stable on
    redpanda-edge, or `timeout_s` elapses.

    A group is "ready" only once its members have joined and a rebalance has
    settled (STATE == "Stable"). An absent group, an Empty group, or a group
    mid-rebalance is treated as not-ready. Returns True when all groups are
    ready; False on timeout — the runner treats False as a hard gate failure
    rather than running tests against a cold pipeline.
    """
    deadline = time.monotonic() + timeout_s
    pending = set(groups)
    last_report: set[str] | None = None
    while time.monotonic() < deadline:
        pending = {g for g in pending if _consumer_group_state(g) != "Stable"}
        if not pending:
            print("    pipeline warm -- all consumer groups Stable")
            return True
        if pending != last_report:
            print(f"    waiting on consumer groups: {', '.join(sorted(pending))}")
            last_report = set(pending)
        time.sleep(2)
    print(f"    TIMEOUT after {timeout_s}s -- still cold: {', '.join(sorted(pending))}")
    return False


# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------
def wait_for_metric_increase(name: str, baseline: float,
                              labels: dict | None = None,
                              timeout_s: int = 10) -> float:
    """Poll /metrics until `name{labels}` exceeds `baseline`, or timeout."""
    deadline = time.monotonic() + timeout_s
    last = baseline
    while time.monotonic() < deadline:
        try:
            txt = scrape_metrics()
        except Exception:
            time.sleep(0.5)
            continue
        last = metric_value(txt, name, labels)
        if last > baseline:
            return last
        time.sleep(0.5)
    return last
