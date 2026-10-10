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

WHY IT ANSWERS. A destination with intake returns an answer for each event it
accepted. A fixed list cannot follow events whose ids change on every replay
(the event id is derived from the fault's detection time), so an optional
responder builds one answer per recorded event from a configured template and
serves it after the fixed list. Left unconfigured, the stand-in answers
nothing and behaves exactly as before.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping

import pointer

log = logging.getLogger("egress.stub_sink")

MAX_BODY_BYTES = 1024 * 1024
RECEIVED_FILE_NAME = "received.jsonl"
LAST_KEPT = 5

DATA_DIR = os.getenv("STUB_SINK_DIR", "/data")
PORT = int(os.getenv("STUB_SINK_PORT", "8080"))
KIND_FIELD = os.getenv("STUB_SINK_KIND_FIELD", "kind")
ID_FIELD = os.getenv("STUB_SINK_ID_FIELD", "id")
# Where the stand-in's own outgoing artifacts live -- ADR-0046 v2 §5: a
# destination with intake returns artifacts of a declared kind, and this is
# the stand-in for that return path. Unset, or set to a file that is not
# there, is not an error: an intake poll against a destination with nothing
# to return yet gets `{"items": []}`, not a failure.
ARTIFACTS_PATH = os.getenv("OPENDDIL_STUB_ARTIFACTS_PATH")
# The answer config (see `Responder`). Unset, or a path with no file, means
# no answers. A file that is there but broken is a startup error, never "no
# answers": a misconfigured responder must not look like a quiet one.
RESPONSE_PATH = os.getenv("OPENDDIL_STUB_RESPONSE_PATH")

_UNRESOLVED = object()


def _set_at(doc: dict, ptr: str, value: Any) -> bool:
    """Write `value` at `ptr` in `doc`. `pointer.set` refuses to step through
    lists, and an answer template carries lists (a part list, an approval
    chain), so this setter indexes them: a numeric token indexes an EXISTING
    list; any other token steps into a dict, creating missing intermediate
    dicts. False when the pointer cannot be written (index out of range, a
    step through a scalar), so the caller can treat it as unresolved."""
    try:
        toks = pointer.tokens(ptr)
    except pointer.PointerError:
        return False
    if not toks:
        return False
    node: Any = doc
    for i, tok in enumerate(toks):
        last = i == len(toks) - 1
        if isinstance(node, list):
            if not tok.isdigit() or int(tok) >= len(node):
                return False
            if last:
                node[int(tok)] = value
                return True
            node = node[int(tok)]
        elif isinstance(node, dict):
            if last:
                node[tok] = value
                return True
            if tok not in node:
                node[tok] = {}
            node = node[tok]
        else:
            return False
    return False


class Responder:
    """Builds one answer per event from a configured template. See the
    module docstring for why; the config shape is documented beside the
    chart's `egress.stubSink.respond` value."""

    def __init__(self, config: Any) -> None:
        if not isinstance(config, dict):
            raise ValueError("response config must be a JSON object")
        self._body_field = config.get("body_field")
        if self._body_field is not None and not isinstance(self._body_field, str):
            raise ValueError("response config: body_field must be a string")
        self._kind_field = config.get("kind_field")
        self._kind = config.get("kind")
        if (self._kind_field is None) != (self._kind is None):
            raise ValueError("response config: kind_field and kind go together")
        if self._kind_field is not None and not isinstance(self._kind_field, str):
            raise ValueError("response config: kind_field must be a string")
        ident = config.get("id")
        if not isinstance(ident, dict):
            raise ValueError("response config: id must be an object")
        self._id_pointer = ident.get("pointer")
        self._id_from = ident.get("from")
        self._id_prefix = ident.get("prefix")
        if not (isinstance(self._id_pointer, str) and isinstance(self._id_from, str)
                and isinstance(self._id_prefix, str)):
            raise ValueError("response config: id needs string pointer, from and prefix")
        copies = config.get("copy")
        if not isinstance(copies, dict) or not copies or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in copies.items()):
            raise ValueError("response config: copy must be a non-empty object of pointers")
        self._copy = dict(copies)
        stamp = config.get("stamp", [])
        if not isinstance(stamp, list) or not all(isinstance(p, str) for p in stamp):
            raise ValueError("response config: stamp must be a list of pointers")
        self._stamp = list(stamp)
        template = config.get("template")
        if not isinstance(template, dict):
            raise ValueError("response config: template must be an object")
        self._template = template

    def _event_of(self, body: Any) -> dict | None:
        if not isinstance(body, dict):
            return None
        if self._kind_field is not None and body.get(self._kind_field) != self._kind:
            return None
        if self._body_field is None:
            return body
        event = body.get(self._body_field)
        return event if isinstance(event, dict) else None

    def answer_id(self, answer: dict) -> Any:
        return pointer.get(answer, self._id_pointer)

    def answer(self, body: Any, received_at: str) -> dict | None:
        event = self._event_of(body)
        if event is None:
            return None
        id_value = pointer.get(event, self._id_from, _UNRESOLVED)
        out = copy.deepcopy(self._template)

        def unresolved(ptr: str) -> None:
            # The pointer and the event's own id only -- never the body.
            log.warning("no answer: %s does not resolve (event id %s)", ptr,
                        "unknown" if id_value is _UNRESOLVED else id_value)

        if id_value is _UNRESOLVED:
            unresolved(self._id_from)
            return None
        for target, source in self._copy.items():
            value = pointer.get(event, source, _UNRESOLVED)
            if value is _UNRESOLVED:
                unresolved(source)
                return None
            if not _set_at(out, target, copy.deepcopy(value)):
                unresolved(target)
                return None
        for target in self._stamp:
            if not _set_at(out, target, received_at):
                unresolved(target)
                return None
        if not _set_at(out, self._id_pointer, self._id_prefix + str(id_value)):
            unresolved(self._id_pointer)
            return None
        return out


def _load_responder(path: str | os.PathLike | None) -> Responder | None:
    """The responder `RESPONSE_PATH` names, or None when there is nothing to
    read. Unlike `_load_artifacts`, a file that is there but not valid is an
    error (`ValueError`): see `RESPONSE_PATH`."""
    if not path:
        return None
    candidate = Path(path)
    if not candidate.is_file():
        return None
    try:
        config = json.loads(candidate.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ValueError(f"response config {candidate} is not valid JSON: {exc}") from exc
    return Responder(config)


def _load_artifacts(path: str | os.PathLike | None) -> list[Any]:
    """The list `GET /artifacts` serves, read once at startup -- not
    re-read per request, so a file edited after the process starts has no
    effect until the next restart, the same lifetime `ReceivedStore` gives
    the received log's on-disk file. Anything that is not a JSON list at
    that path (absent env, missing file, malformed JSON, a JSON value that
    is not a list) is `[]`, never an error: this stand-in has nothing to
    return until it is given something, and that is a fact an intake poll
    reads as an empty page, not a fault."""
    if not path:
        return []
    candidate = Path(path)
    if not candidate.is_file():
        return []
    try:
        data = json.loads(candidate.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return data if isinstance(data, list) else []


class ReceivedStore:
    """What this stub has received: an append-only `received.jsonl` on
    disk, plus the in-memory counts `GET /received` answers from.

    Re-read at start (`_load_existing`) so the counts survive a restart
    whenever the directory does — the file is the durable truth, the
    in-memory counts are just a fast read of it."""

    def __init__(self, directory: str | os.PathLike, *, kind_field: str = KIND_FIELD,
                 id_field: str = ID_FIELD, responder: Responder | None = None) -> None:
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / RECEIVED_FILE_NAME
        self._kind_field = kind_field
        self._id_field = id_field
        self._responder = responder
        self._answers: OrderedDict[Any, dict] = OrderedDict()
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
                self._apply(entry.get("body"), entry.get("received_at", ""))

    def _apply(self, body: Any, received_at: str) -> None:
        self._total += 1
        if self._responder is not None:
            answer = self._responder.answer(body, received_at)
            if answer is not None:
                # Keyed by answer id: a replayed event replaces its answer
                # in place, so there is one answer per event, not per POST.
                self._answers[self._responder.answer_id(answer)] = answer
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
        received_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entry = {
            "received_at": received_at,
            "path": path,
            "headers": headers,
            "body": body,
        }
        with self._lock:
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            self._apply(body, received_at)
            return self._total

    def answers(self) -> list:
        with self._lock:
            return list(self._answers.values())

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "total": self._total,
                "answered": len(self._answers),
                "distinct_ids": len(self._ids),
                "by_kind": dict(self._by_kind),
                "last": list(self._last),
            }


def make_handler(store: ReceivedStore, artifacts: list[Any] = ()) -> type[BaseHTTPRequestHandler]:
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
            if self.path == "/artifacts":
                self._send_json(200, {"items": list(artifacts) + store.answers()})
                return
            self._send_json(404, {"error": "not found"})

    return Handler


def make_server(
    directory: str | os.PathLike, *, host: str = "0.0.0.0", port: int = 0,
    kind_field: str = KIND_FIELD, id_field: str = ID_FIELD,
    artifacts_path: str | os.PathLike | None = ARTIFACTS_PATH,
    response_path: str | os.PathLike | None = RESPONSE_PATH,
) -> ThreadingHTTPServer:
    responder = _load_responder(response_path)
    store = ReceivedStore(directory, kind_field=kind_field, id_field=id_field,
                          responder=responder)
    artifacts = _load_artifacts(artifacts_path)
    return ThreadingHTTPServer((host, port), make_handler(store, artifacts))


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
