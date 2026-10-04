"""manual_qa_stub.py — the stand-in for the manual question service.

Until the upstream manual question service is confirmed, this is what
gateway/pep.py's OPENDDIL_MANUAL_QA_URL can point at: a stdlib HTTP server
(no third-party deps, same discipline as egress/stub_sink.py) that answers
POST /ask from the public fixture under tests/fixtures/s1000d-array-module/
— the same fixture gateway/test_pep_manual_ask.py's citations are drawn
from.

A question that mentions the fixture's own bit_code or the words "array
module" gets an answer citing the fault-isolation DMC and that procedure's
own last corrective step. Anything else gets an answer with empty
citations, so the "no citations" refusal path has something real to
exercise.

MANUAL_QA_STUB_MODE=out_of_scope makes every reply cite the fixture's own
illustrated-parts-data DMC instead, regardless of the question — the SAME
module the fixture already carries, just not one most requests will have
asked about — to demonstrate the other refusal path (a citation outside
the requested scope) without needing a second fixture.
"""
from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

log = logging.getLogger("gateway.manual_qa_stub")

PORT = int(os.getenv("MANUAL_QA_STUB_PORT", "8099"))
MAX_BODY_BYTES = 64 * 1024

# Where the public fixture lives -- mounted or copied in alongside this
# stub in compose. Default assumes this file still lives at
# <repo>/gateway/manual_qa_stub.py and the fixture at its usual repo path.
FIXTURE_DIR = os.getenv(
    "MANUAL_QA_FIXTURE_DIR",
    str(Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "s1000d-array-module"),
)

# The fault-isolation module's own last corrective action (DMC-...-421A-A:
# "Array Module BIT Failure" > "Re-run BIT" > "Check module power LED" >
# "Reseat connector") -- GROUND-TRUTH.json names the module but not this
# step text, so it is named here instead of re-parsed out of the DMC XML.
FAULT_ISOLATION_STEP = "Reseat connector"


def _load_ground_truth(directory: str | os.PathLike) -> dict[str, Any]:
    """GROUND-TRUTH.json's contents, or {} if it is missing or not an
    object. A stub with no fixture to read answers every question with
    empty citations, which is still a well-formed (if unhelpful) reply —
    never a server error."""
    path = Path(directory) / "GROUND-TRUTH.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def build_reply(question: str, ground_truth: dict[str, Any], *, out_of_scope: bool) -> dict[str, Any]:
    """The stub's one piece of judgment: does this question mention the
    fault this fixture is about? Deliberately crude — a substring match on
    the fixture's own bit code or on the words "array module" — because
    this stands in for an answering service, never for the service's own
    reasoning. Always returns {answer, citations}, the shape
    gateway/manual_qa.py's enforce_citations expects to judge.
    """
    citations_block = ground_truth.get("citations") if isinstance(ground_truth, dict) else None
    citations_block = citations_block if isinstance(citations_block, dict) else {}
    fault_isolation = citations_block.get("fault_isolation")
    fault_isolation = fault_isolation if isinstance(fault_isolation, dict) else {}
    fault_dmc = fault_isolation.get("dmc")

    if out_of_scope:
        ipd = citations_block.get("ipd")
        ipd = ipd if isinstance(ipd, dict) else {}
        out_dmc = ipd.get("dmc")
        if not isinstance(out_dmc, str) or not out_dmc:
            return {"answer": "", "citations": []}
        return {
            "answer": ground_truth.get("bit_text", "") or "array module fault",
            "citations": [{"dmc": out_dmc, "title": "illustrated parts data"}],
        }

    bit_code = ground_truth.get("bit_code") or ""
    q = (question or "").lower()
    mentions = (bool(bit_code) and bit_code.lower() in q) or "array module" in q
    if mentions and isinstance(fault_dmc, str) and fault_dmc:
        return {
            "answer": ground_truth.get("bit_text") or "array module fault, section 3",
            "citations": [{"dmc": fault_dmc, "step": FAULT_ISOLATION_STEP}],
        }
    return {"answer": "No matching procedure found for that question.", "citations": []}


def make_handler(ground_truth: dict[str, Any], *, out_of_scope: bool) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "openddil-manual-qa-stub/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            # The request line only, through the standard logger -- never
            # the question text, same discipline as egress/stub_sink.py.
            log.info("%s - %s", self.address_string(), fmt % args)

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/ask":
                self._send_json(404, {"error": "not found"})
                return
            try:
                length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY_BYTES)
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, ValueError):
                self._send_json(400, {"error": "body is not JSON"})
                return
            question = body.get("question", "") if isinstance(body, dict) else ""
            reply = build_reply(question, ground_truth, out_of_scope=out_of_scope)
            self._send_json(200, reply)

    return Handler


def make_server(*, host: str = "0.0.0.0", port: int = 0,
                 fixture_dir: str | os.PathLike = FIXTURE_DIR,
                 out_of_scope: bool = False) -> ThreadingHTTPServer:
    ground_truth = _load_ground_truth(fixture_dir)
    return ThreadingHTTPServer((host, port), make_handler(ground_truth, out_of_scope=out_of_scope))


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [manual-qa-stub] %(message)s",
    )
    out_of_scope = os.getenv("MANUAL_QA_STUB_MODE", "") == "out_of_scope"
    server = make_server(host="0.0.0.0", port=PORT, out_of_scope=out_of_scope)
    log.info("manual question service stub listening on :%d, fixture=%s, out_of_scope=%s",
              PORT, FIXTURE_DIR, out_of_scope)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
