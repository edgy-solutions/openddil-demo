#!/usr/bin/env python3
"""Read-only decisions endpoint for the egress admission pane — ADR-0043 /
Arc 2 Slice 2.

WHY THIS EXISTS
`gate.py`'s module docstring records the gap: refusals are not persisted
anywhere. A refused record is simply not produced to `egress-c2-status`, so
nothing downstream of the gate can say "these six were refused, and here is
why" — there is no store to read that from. This module is that read
surface: it asks the SAME question `main.py` asks, through the SAME
`EgressGate.decide` path, and answers it synchronously over HTTP instead of
forwarding bytes to a sink topic.

WHY A SEPARATE PROCESS AND NOT A ROUTE INSIDE `main.py`
`main.py`'s loop is a blocking Kafka consumer with its own commit semantics;
grafting a synchronous HTTP server onto it would mean the worker either stops
polling while it serves a request or the request handler shares state with a
consume loop it was never designed to be read from mid-stream. Separate
process, same gate code, same destination corpus — the thing that must never
diverge is the DECISION, not the process boundary around it.

WHERE THE FLEET RECORDS COME FROM — MEASURED, NOT ASSUMED
Three candidates exist under compose: the `asset-logistics-status` topic
`main.py` itself consumes, `ontology/releasability.yaml` (the declaration),
and `asset_logistics_status` in Postgres. Measured 2026-09-27 against the
running compose stack:

  * `asset-logistics-status` is a HOT, COMPACTED topic (8 partitions) that
    `tests/hero_scenario_v3/_cm_helpers.py` already has to drain with a
    fresh consumer group and a `per_partition_tail` heuristic to answer
    "what is each key's latest record" — that test helper takes up to 30s
    for a few thousand records. Fine for a test run; wrong for a page load,
    and re-implementing that heuristic here would be a second, worse copy
    of it.
  * The Postgres table `asset_logistics_status` is `openddil-projector`'s
    read-model mirror of that EXACT topic (UPSERT keyed by `asset_id`,
    `originator_nation`/`releasable_to` columns already extracted) — a
    plain indexed SELECT answers "latest state of every asset" in
    milliseconds, and it is populated from the same wire records the
    running gate decides over, not a second source of truth.
  * The table holds MORE keys than the declaration names, and most of them
    carry no releasability label at all.

So: Postgres for the record set AND the label values — what is actually on
the wire right now, unscoped.

WHY THE RECORD SET IS NOT FILTERED TO THE DECLARED FLEET
An earlier revision of this module took its record set from the declaration
and asked Postgres only about those ids. That was wrong, and the way it was
wrong is worth keeping written down, because it reads as tidiness.

The running gate's record set is the stream. It decides every key that
arrives, and the declaration is what the PDP consults to ANSWER — never a
list of which questions get asked. Scoping the pane's record set to the
declaration therefore renders a different question than the gate answers,
and it fails in one direction only: a record carrying no label vanishes from
the page instead of appearing as the refusal it is. Measured on this stack,
`unlabelled` was 4533 of the gate's 4594 refusals — the dominant refusal in
the system, and the one an operator most needs to see, because it means
something upstream is emitting records with no releasability label.

That is also the failure ADR-0044 rules out for lifecycle, in a new place:
an unlabelled asset and an asset that does not exist must never render
alike. A stale key in a compacted topic is a reason to clean the topic, not
a reason for this page to decide what an operator is allowed to notice.

WHAT THIS MODULE MUST NOT DO
Produce, write, or create anything. It calls `EgressGate.for_destination`
and `EgressGate.decide` — the exact functions `main.py` calls — and nothing
in this file re-implements or paraphrases a clause of the release predicate.

A SECOND RECORD SOURCE — ADR-0046 s5 (maintenance bridge)
`system:mmis-stand-in` is not another C2 destination: it is the third gate
instance ADR-0046 s5 describes (source `maint-actions-decided`, sink
`egress-mmis-actions`), reading `maintenance_actions` — the owning tier's
local decisions about arrived `MaintenanceAction`s — instead of
`asset_logistics_status`. `RECORD_SOURCE` below is the whole of that
branch: a destination-to-fetch-function map, consulted once per request.
Every destination not named in it reads `asset_logistics_status`, which is
also what an UNKNOWN destination does — that was already true before this
map existed (the old code asked Postgres for that one table regardless of
`destination`), and this change does not narrow it. The fetched rows are
still decided through the exact same `EgressGate.for_destination(...).decide
(record)` call as any C2 record, built as a `{"originator_nation":
..., "releasable_to": ...}` label dict so the gate reads a maintenance
action's label exactly the way it reads an asset's — one predicate, one
label shape, no second extraction path. The work-order fields
(`action_id`, `event_id`, `owning_tier`, `work_order`, `approval_chain`,
`decided_at`, `provenance`) ride beside the decision in the response but
play no part in deciding it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import asyncpg

sys.path.insert(0, str(Path(__file__).parent))

from gate import (  # noqa: E402
    REASON_AUTHZ_UNAVAILABLE,
    AuthzUnavailable,
    EgressGate,
)

LISTEN_PORT = int(os.getenv("OPENDDIL_EGRESS_PANE_PORT", "8090"))
POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN", "postgres://postgres:password@postgres-hq:5432/openddil")
# Same default `main.py` uses for OPENDDIL_EGRESS_DESTINATION — the pane's
# default view is the same link the running gate actually enforces.
DEFAULT_DESTINATION = os.getenv("OPENDDIL_EGRESS_DESTINATION", "system:c2-stand-in-atl")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [pane-api] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("egress.pane_api")


async def _fetch_all_records() -> list[dict[str, Any]]:
    """EVERY key in the projector's mirror of asset-logistics-status, with
    whatever label it currently carries — which for some keys is no label at
    all, read as `unlabelled` by `gate.classify` rather than as a guess at a
    nation.

    Deliberately unscoped. The record set is not a question this module gets
    to answer: it is whatever arrived on the stream, and the gate's answer
    over exactly that set is what the pane exists to show. `ORDER BY
    asset_id` only for a stable response order across requests."""
    conn = await asyncpg.connect(POSTGRES_DSN)
    try:
        rows = await conn.fetch(
            "SELECT asset_id, originator_nation, releasable_to "
            "FROM asset_logistics_status ORDER BY asset_id"
        )
    finally:
        await conn.close()
    return [
        {
            "asset_id": row["asset_id"],
            "originator_nation": row["originator_nation"],
            "releasable_to": list(row["releasable_to"] or []),
        }
        for row in rows
    ]


async def _fetch_maintenance_actions() -> list[dict[str, Any]]:
    """Every row in `maintenance_actions` (ADR-0046 s5) — the owning tier's
    local decisions about arrived `MaintenanceAction`s, released toward
    `system:mmis-stand-in`. Unscoped for the same reason `_fetch_all_records`
    is: the gate decides whatever is in this table, not a declared subset,
    and an unlabelled action must render as the refusal it is rather than
    vanish. `ORDER BY action_id` only for a stable response order."""
    conn = await asyncpg.connect(POSTGRES_DSN)
    try:
        rows = await conn.fetch(
            "SELECT action_id, event_id, asset_id, owning_tier, "
            "originator_nation, releasable_to, work_order, approval_chain, "
            "provenance, decided_at "
            "FROM maintenance_actions ORDER BY action_id"
        )
    finally:
        await conn.close()
    return [
        {
            "action_id": row["action_id"],
            "event_id": row["event_id"],
            "asset_id": row["asset_id"],
            "owning_tier": row["owning_tier"],
            "originator_nation": row["originator_nation"],
            "releasable_to": list(row["releasable_to"] or []),
            "work_order": json.loads(row["work_order"]),
            "approval_chain": json.loads(row["approval_chain"]),
            "provenance": json.loads(row["provenance"]) if row["provenance"] else {},
            "decided_at": row["decided_at"].isoformat(),
        }
        for row in rows
    ]


# Destination -> fetch function. See the module docstring's "A SECOND RECORD
# SOURCE" section. `.get(destination, _fetch_all_records)` below is the
# whole of the branch: anything not named here, including a destination this
# corpus has never declared, reads `asset_logistics_status` — exactly what
# every destination did before this map existed.
RECORD_SOURCE: dict[str, Any] = {
    "system:mmis-stand-in": _fetch_maintenance_actions,
}

# The extra fields a maintenance-action record carries beside the decision —
# present only when the row came from `_fetch_maintenance_actions`.
_ACTION_FIELDS = (
    "action_id", "event_id", "owning_tier", "work_order", "approval_chain",
    "decided_at", "provenance",
)


def build_decisions(destination: str) -> dict[str, Any]:
    """One destination's whole answer, decided record by record through the
    real gate. Raises `AuthzUnavailable` when the PDP could not be asked at
    all — the caller must surface that as an outage, not as 14 refusals."""
    gate = EgressGate.for_destination(destination)  # the one PDP call

    fetch = RECORD_SOURCE.get(destination, _fetch_all_records)
    wire_records = asyncio.run(fetch())

    records = []
    admitted = 0
    for label in wire_records:
        asset_id = label["asset_id"]
        # A maintenance action is keyed by action_id, not asset_id — several
        # actions can target the same asset — but the gate is built so the
        # SAME label shape (originator_nation/releasable_to) decides either
        # record kind; nothing here re-derives or re-reads the label
        # differently per source.
        key = label.get("action_id", asset_id)
        decision = gate.decide(
            {"originator_nation": label["originator_nation"],
             "releasable_to": label["releasable_to"]},
            key=key,
        )
        if decision.allowed:
            admitted += 1
        record = {
            "asset_id": asset_id,
            "originator_nation": label["originator_nation"],
            "releasable_to": label["releasable_to"],
            "allowed": decision.allowed,
            # null on admit — `allowed` already says so, and "admit" is not
            # a refusal reason a reader should have to filter back out.
            "reason": None if decision.allowed else decision.reason,
            "decision_id": decision.decision_id,
        }
        for field in _ACTION_FIELDS:
            if field in label:
                record[field] = label[field]
        records.append(record)

    return {
        "destination": destination,
        "policy_version": gate.policy_version,
        "corpus_version": gate.corpus_version,
        "admitted": admitted,
        "refused": len(records) - admitted,
        "records": records,
    }


class PaneApi(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter access log
        log.debug(fmt, *args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Compose serves this on its own published port, a different origin
        # from the frontend's — unlike the Helm path, there is no same-origin
        # proxy in front of it. Read-only and cookie-free, so a blanket
        # allow costs nothing a same-origin deployment would have avoided.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if parsed.path != "/decisions":
            self._send_json(404, {"error": "unknown path"})
            return

        params = urllib.parse.parse_qs(parsed.query)
        destination = (params.get("destination") or [DEFAULT_DESTINATION])[0]

        try:
            payload = build_decisions(destination)
        except AuthzUnavailable as exc:
            # NOT a refused-records response. See gate.py: an outage and a
            # deny are different events, and rendering an outage as "0
            # admitted, 14 refused" would be the pane lying about policy.
            log.warning("PDP unavailable for destination=%s: %s", destination, exc)
            self._send_json(503, {
                "destination": destination,
                "error": REASON_AUTHZ_UNAVAILABLE,
                "detail": str(exc),
            })
            return
        except Exception as exc:  # noqa: BLE001 — a 500 with a body beats a hang
            log.exception("unhandled error building /decisions destination=%s",
                          destination)
            self._send_json(500, {
                "destination": destination,
                "error": "internal_error",
                "detail": str(exc),
            })
            return

        self._send_json(200, payload)


def main() -> None:
    log.info("egress pane-api listening on :%s (postgres=...@%s)",
              LISTEN_PORT, POSTGRES_DSN.rsplit("@", 1)[-1])
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), PaneApi).serve_forever()


if __name__ == "__main__":
    main()
