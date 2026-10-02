"""stub_sink.py — the stand-in destination.

Until a destination's credential exists, nothing can actually deliver to it.
This is what `forwarder.py` POSTs to in that interval: a stdlib HTTP server
that records what it received, so the measured counts have something real
to be measured against — see the module docstring in forwarder.py.

NEVER THE TOKEN VALUE. A request arrives here carrying whatever
`Authorization` header the forwarder set; this process records only whether
one was present, never its value — not in the receipt log, and not in the
request log `BaseHTTPRequestHandler` would otherwise write, which is left to
its default (the request line only, no headers).
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping

log = logging.getLogger("egress.stub_sink")

MAX_BODY_BYTES = 1024 * 1024
RECEIVED_FILE_NAME = "received.jsonl"
LAST_KEPT = 5

DATA_DIR = os.getenv("STUB_SINK_DIR", "/data")
PORT = int(os.getenv("STUB_SINK_PORT", "8080"))
KIND_FIELD = os.getenv("STUB_SINK_KIND_FIELD", "kind")
ID_FIELD = os.getenv("STUB_SINK_ID_FIELD", "id")


class ReceivedStore:
    """What this stub has received: an append-only `received.jsonl` on
    disk, plus the in-memory counts `GET /received` answers from.

    Re-read at start (`_load_existing`) so the counts survive a restart
    whenever the directory does — the file is the durable truth, the
    in-memory counts are just a fast read of it."""

    def __init__(self, directory: str | os.PathLike, *, kind_field: str = KIND_FIELD,
                 id_field: str = ID_FIELD) -> None:
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / RECEIVED_FILE_NAME
        self._kind_field = kind_field
        self._id_field = id_field
        self._lock = threading.Lock()
        self._total = 0
        self._ids: set[Any] = set()
        self._by_kind: dict[str, int] = {}
        self._last: list[Any] = []
        self._load_existing()

    def _load_existing(self) -> None:
        if not self._path.exists():
            return
        with self._path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                self._apply(entry.get("body"))

    def _apply(self, body: Any) -> None:
        self._total += 1
        if isinstance(body, dict):
            if self._id_field in body:
                self._ids.add(body[self._id_field])
            kind = body.get(self._kind_field)
            if kind is not None:
                self._by_kind[kind] = self._by_kind.get(kind, 0) + 1
        self._last.append(body)
        if len(self._last) > LAST_KEPT:
            self._last = self._last[-LAST_KEPT:]

    def record(self, path: str, headers: dict[str, Any], body: Any) -> int:
        entry = {
            "received_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "path": path,
            "headers": headers,
            "body": body,
        }
        with self._lock:
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            self._apply(body)
            return self._total

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "total": self._total,
                "distinct_ids": len(self._ids),
                "by_kind": dict(self._by_kind),
                "last": list(self._last),
            }


def make_handler(store: ReceivedStore) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "openddil-stub-sink/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            # The default request-line-only log, routed through the
            # standard logger instead of stderr. Header VALUES are never
            # part of `fmt`/`args` here — see the module docstring.
            log.info("%s - %s", self.address_string(), fmt % args)

        def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            try:
                length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY_BYTES)
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                self._send_json(400, {"error": "body is not JSON"})
                return

            headers = {
                "content-type": self.headers.get("Content-Type", ""),
                "authorization present": "Authorization" in self.headers,
            }
            n = store.record(self.path, headers, body)
            self._send_json(202, {"received": n})

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
                return
            if self.path == "/received":
                self._send_json(200, store.summary())
                return
            self._send_json(404, {"error": "not found"})

    return Handler


def make_server(
    directory: str | os.PathLike, *, host: str = "0.0.0.0", port: int = 0,
    kind_field: str = KIND_FIELD, id_field: str = ID_FIELD,
) -> ThreadingHTTPServer:
    store = ReceivedStore(directory, kind_field=kind_field, id_field=id_field)
    return ThreadingHTTPServer((host, port), make_handler(store))


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [stub-sink] %(message)s",
        stream=None,
    )
    server = make_server(DATA_DIR, host="0.0.0.0", port=PORT)
    log.info("stub sink listening on :%d, dir=%s", PORT, DATA_DIR)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
