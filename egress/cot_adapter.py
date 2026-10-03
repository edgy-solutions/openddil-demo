"""The Contract A -> Cursor on Target bridge — ADR-0043 Arc 2 Slice 2.

Reads the egress gate's SINK topic only (`egress-c2-status`, the gate's
`OPENDDIL_EGRESS_SINK_TOPIC`) and writes one CoT `<event>` per record over a
plaintext TCP socket to a TAK server. It is a TRANSLATOR, not a second
decider: the gate on `main.py`/`gate.py` already decided every record this
process ever sees — admitted, byte for byte, onto the sink topic — and this
module's only remaining job is to say the same thing in CoT's shape.

THE FENCE
A record reaching this process that is not labelled (`Label.is_labelled`
false) produces no event at all, logged as `COT_SKIP`. This is NOT a second
releasability decision — the gate already refuses every unlabelled record
before it can reach the sink topic, so an unlabelled record arriving here
means something upstream is misconfigured (the adapter pointed at the wrong
topic, or a producer writing to the sink directly). The fence exists so that
misconfiguration fails by emitting nothing rather than by emitting a CoT
event with no releasability claim on it, which a TAK client would have no
way to tell apart from "cleared for everyone". The adapter never consults
`releasable_to`/`originator_nation` against any destination's entitlement —
that question was answered once, upstream, by the gate.

ONE SINK, ONE LINK, SAME REASONING AS THE GATE
Like `egress-gate-c2`, this is per-consumer and disposable: one TAK endpoint,
one consumer group. A second CoT consumer is a second adapter pointed at the
same sink topic with its own group id, not a fan-out added to this one.

REUSE, NOT COPY
`decode` (byte-level JSON-or-proto decoding) is imported from `main`, and
`extract_label` is imported from `gate` — the same functions the gate itself
uses, so this process can never drift from what "labelled" means there.

KNOWN SIDE EFFECT OF IMPORTING `main`: `main.py` calls `logging.basicConfig`
at module scope (not inside its `main()`), which attaches a handler to the
root logger tagged "[egress]" the moment it is imported. `logging.basicConfig`
is a no-op once the root logger already has a handler, so without
`force=True` below, every line this module logs would silently inherit that
tag instead of its own. `force=True` re-asserts this module's own format
immediately after the import. Flagged per the build spec rather than worked
around by moving `decode` out of `main.py` — nothing in `main.py` or `gate.py`
was changed to make this import work.

COMMIT ORDERING
Offsets are committed only after a record's processing is fully decided: the
event was written to the TAK socket, OR the fence determined no event should
be written at all. A commit is never issued before that decision is known, so
a crash between "sent" and "committed" costs at most a duplicate CoT event on
redelivery — never a silently dropped one.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from gate import Label, extract_label  # noqa: E402
from main import decode  # noqa: E402 — reused, not copied; see module docstring
from startup import require_topics  # noqa: E402

BROKERS = os.getenv("OPENDDIL_COT_BROKERS", "redpanda-hq:19092")
SOURCE_TOPIC = os.getenv("OPENDDIL_COT_SOURCE_TOPIC", "egress-c2-status")
GROUP = os.getenv("OPENDDIL_COT_GROUP", "egress-cot-adapter-c2")
TAK_HOST = os.getenv("OPENDDIL_COT_TAK_HOST", "tak-server")
TAK_PORT = int(os.getenv("OPENDDIL_COT_TAK_PORT", "8087"))
STALE_S = int(os.getenv("OPENDDIL_COT_STALE_S", "300"))
COT_TYPE = os.getenv("OPENDDIL_COT_TYPE", "a-u-G")
POLL_TIMEOUT = float(os.getenv("OPENDDIL_COT_POLL_TIMEOUT", "1.0"))

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [cot-adapter] %(message)s",
    stream=sys.stdout,
    force=True,  # see "KNOWN SIDE EFFECT" in the module docstring
)
log = logging.getLogger("cot_adapter")

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s — draining and stopping", signum)
    _running = False


def _fmt_time(value: datetime) -> str:
    """UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`, the format the build spec calls for."""
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def build_event(record: dict, key: str | None, label: Label) -> ET.Element | None:
    """Build one CoT `<event>` for an admitted record, or `None` at the fence.

    `label` is passed in rather than re-derived so a caller that already
    extracted it (to decide whether to call this at all, or to log the
    emission afterward) does it exactly once.
    """
    if not label.is_labelled:
        log.info("COT_SKIP %s", json.dumps({"key": key, "reason": "unlabelled"}))
        return None

    status = record.get("status")
    status = status if isinstance(status, dict) else {}
    asset_id = key or status.get("asset_id") or ""

    now = datetime.now(timezone.utc)
    stale = now + timedelta(seconds=STALE_S)

    event = ET.Element("event", {
        "version": "2.0",
        "uid": asset_id,
        "type": COT_TYPE,
        "how": "m-f",
        "time": _fmt_time(now),
        "start": _fmt_time(now),
        "stale": _fmt_time(stale),
    })
    ET.SubElement(event, "point", {
        "lat": "0.0", "lon": "0.0",
        "hae": "9999999.0", "ce": "9999999.0", "le": "9999999.0",
    })
    detail = ET.SubElement(event, "detail")
    ET.SubElement(detail, "contact", {"callsign": asset_id})

    release = ET.SubElement(detail, "openddil_release", {
        "originator_nation": label.originator_nation or "",
    })
    # An empty releasable_to is LABELLED AND RELEASABLE TO NOBODY BEYOND THE
    # ORIGINATOR (ADR-0029) — carried as a present element with zero
    # children, never omitted. Omitting it would make "released to nobody
    # beyond the author" and "this record has no release claim at all"
    # indistinguishable on the wire, which is exactly the ambiguity the fence
    # above exists to prevent.
    for nation in label.releasable_to:
        ET.SubElement(release, "releasable_to", {"nation": nation})

    revision_raw = status.get("status_revision")
    try:
        revision = int(revision_raw) if revision_raw not in (None, "") else 0
    except (TypeError, ValueError):
        revision = 0

    ET.SubElement(detail, "openddil_status", {
        "asset_id": asset_id,
        "platform_variant": status.get("platform_variant") or "",
        "overall_severity": status.get("overall_severity") or "",
        "computed_at": status.get("computed_at") or "",
        "status_revision": str(revision),
    })
    return event


class TakSocket:
    """A TCP connection to the TAK server.

    Connects with retries at construction time (persistent failure is fatal —
    same reasoning as the gate's PDP-at-startup check: a process that starts
    with no path to its sink and runs anyway looks exactly like one quietly
    delivering nothing). Reconnects ONCE on a broken pipe before giving up —
    not per-message, so a dead link surfaces as an exit rather than a silent
    retry loop that never recovers and never says so.
    """

    def __init__(self, host: str, port: int, *, retries: int = 30, delay_s: float = 2.0):
        self.host = host
        self.port = port
        self.retries = retries
        self.delay_s = delay_s
        self.sock: socket.socket | None = None
        self._connect(fatal=True)

    def _connect(self, *, fatal: bool) -> None:
        last_exc: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=5)
                log.info("connected to TAK server %s:%s (attempt %d/%d)",
                         self.host, self.port, attempt, self.retries)
                return
            except OSError as exc:
                last_exc = exc
                log.warning("TAK connect attempt %d/%d to %s:%s failed: %s",
                            attempt, self.retries, self.host, self.port, exc)
                if attempt < self.retries:
                    time.sleep(self.delay_s)
        msg = (f"could not connect to TAK server {self.host}:{self.port} "
               f"after {self.retries} attempts: {last_exc}")
        if fatal:
            log.error("FATAL: %s", msg)
            raise SystemExit(2)
        raise ConnectionError(msg)

    def send(self, data: bytes) -> None:
        assert self.sock is not None
        try:
            self.sock.sendall(data)
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            log.warning("TAK socket broken (%s); reconnecting once", exc)
            try:
                self.sock.close()
            except OSError:
                pass
            self._connect(fatal=False)
            assert self.sock is not None
            self.sock.sendall(data)

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass


def main() -> int:
    from confluent_kafka import Consumer  # noqa: PLC0415

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    # R6b: the sink topic this process reads must exist before it opens a
    # TAK socket or subscribes.
    from confluent_kafka.admin import AdminClient  # noqa: PLC0415
    require_topics(AdminClient({"bootstrap.servers": BROKERS}), [SOURCE_TOPIC])

    tak = TakSocket(TAK_HOST, TAK_PORT)

    consumer = Consumer({
        "bootstrap.servers": BROKERS,
        "group.id": GROUP,
        # A new C2 link gets the current picture from the compacted sink
        # topic, not just what is produced after it joins.
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    consumer.subscribe([SOURCE_TOPIC])

    log.info("cot adapter open: source=%s tak=%s:%s type=%s stale=%ss group=%s",
              SOURCE_TOPIC, TAK_HOST, TAK_PORT, COT_TYPE, STALE_S, GROUP)

    seen = 0
    emitted = 0
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
                # The gate only ever forwards records it decoded successfully
                # (see module docstring), so this should not happen on this
                # topic. It is handled rather than left to crash the process,
                # because decode() is deterministic on these bytes — retrying
                # the same message would reproduce the same failure forever.
                log.warning("undecodable record key=%s: %s", key, exc)
                consumer.commit(msg, asynchronous=False)
                continue

            label = extract_label(record)
            event = build_event(record, key, label)
            if event is not None:
                data = ET.tostring(event, encoding="utf-8")
                tak.send(data)
                emitted += 1
                log.info("COT %s", json.dumps({
                    "uid": event.get("uid"),
                    "originator_nation": label.originator_nation,
                    "releasable_to": list(label.releasable_to),
                    "bytes": len(data),
                }))

            # Committed only now: the event is either on the wire to the TAK
            # server, or the fence has already decided none was owed.
            consumer.commit(msg, asynchronous=False)
    finally:
        consumer.close()
        tak.close()
        log.info("cot adapter closed: saw %d records, emitted %d events", seen, emitted)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
