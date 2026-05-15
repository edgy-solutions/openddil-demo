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

REDPANDA_SVC    = "redpanda-edge"
SENSOR_SVC      = "openddil-sensor-ingest"


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
_SENSOR_CONTAINER = "openddil-demo-openddil-sensor-ingest-1"


def send_udp_bytes(data: bytes, host: str = UDP_HOST, port: int = UDP_PORT) -> None:
    """
    Windows Docker Desktop has a long-standing 'UDP black hole' when sending
    from the host to a container's mapped UDP port. We dodge it by running a
    one-shot socat container on the same Docker network that pipes the bytes
    in via stdin and UDP-sends them to the sidecar by service hostname.
    """
    docker = shutil.which("docker") or "docker"
    target = f"{_SENSOR_CONTAINER}:{port}"
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
def build_entity_state_pdu(
    site: int = 1,
    application: int = 1,
    entity: int = 4773,
    kind: int = 1,
    domain: int = 1,
    country: int = 225,
    category: int = 1,
    subcategory: int = 3,
    specific: int = 1,
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
    block waiting for records that don't exist. `offset` is accepted for
    backward compatibility but interpreted only as "default behavior."
    """
    records: list[dict] = []
    deadline = time.monotonic() + timeout_s

    for partition, hw in _partition_watermarks(topic).items():
        if hw <= 0:
            continue
        if time.monotonic() >= deadline:
            break
        want = min(n, hw)
        start_offset = max(0, hw - want)
        remaining = max(1, int(deadline - time.monotonic()))
        cmd = _docker_compose_cmd() + [
            "exec", "-T", REDPANDA_SVC,
            "rpk", "topic", "consume", topic,
            "-p", str(partition),
            "-o", str(start_offset),
            "-n", str(want),
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

    `n` is interpreted as "up to N most recent records per partition". We
    iterate partitions individually so each `rpk` invocation exits cleanly
    once the partition is exhausted (rpk has no global timeout flag and will
    hang if asked for more records than exist).
    """
    delim = b"<<HERO_V3_DELIM>>"
    out: list[bytes] = []
    deadline = time.monotonic() + timeout_s

    for partition, hw in _partition_watermarks(topic).items():
        if hw <= 0:
            continue
        if time.monotonic() >= deadline:
            break
        want = min(n, hw)
        start_offset = max(0, hw - want)
        remaining = max(1, int(deadline - time.monotonic()))
        cmd = _docker_compose_cmd() + [
            "exec", "-T", REDPANDA_SVC,
            "rpk", "topic", "consume", topic,
            "-p", str(partition),
            "-o", str(start_offset),
            "-n", str(want),
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


def _partition_watermarks(topic: str) -> dict[int, int]:
    """Map partition_id -> high_watermark for the topic."""
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC,
        "rpk", "topic", "describe", topic, "--print-partitions",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return {}
    result: dict[int, int] = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"\s*(\d+)\s+\d+\s+\d+\s+\[\d+\]\s+\d+\s+(\d+)", line)
        if m:
            result[int(m.group(1))] = int(m.group(2))
    return result


def topic_high_watermark(topic: str) -> int | None:
    """Return the total message count across all partitions, or None on error."""
    cmd = _docker_compose_cmd() + [
        "exec", "-T", REDPANDA_SVC,
        "rpk", "topic", "describe", topic, "--print-partitions",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=10, text=True)
    except subprocess.TimeoutExpired:
        return None
    total = 0
    for line in proc.stdout.splitlines():
        m = re.match(r"\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s+", line)
        if m:
            total += int(m.group(2))
    return total


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------
def scrape_metrics(url: str = METRICS_URL, timeout_s: int = 5) -> str:
    with urllib.request.urlopen(url, timeout=timeout_s) as resp:
        return resp.read().decode()


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
