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

A GENERIC RECORD KIND, SELECTED BY `kind` — no per-destination code
`GET /decisions?destination=D&kind=K` reads `intake_records` (ADR-0046 s5's
generic record store), filtered to rows already admitted at intake time for
kind `K`, and re-decides each one fresh through
`EgressGate.for_destination(D, kind=K)` — the destination's own nations and
`accepts` list, not intake's. A destination whose `accepts` does not list
`K` refuses every row `kind_not_accepted`; `EgressGate.decide` makes that
call itself, from the `kind` it was constructed with, so nothing here
re-implements the check. No destination-to-fetch-function map and no
per-kind branch: one query, one gate call, for any `K` the table holds.
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
from typing import Any, Mapping

import asyncpg

sys.path.insert(0, str(Path(__file__).parent))

from gate import (  # noqa: E402
    REASON_AUTHZ_UNAVAILABLE,
    AuthzUnavailable,
    EgressGate,
)
from startup import require_tables, store_dsn_from_env  # noqa: E402

LISTEN_PORT = int(os.getenv("OPENDDIL_EGRESS_PANE_PORT", "8090"))
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
    conn = await asyncpg.connect(store_dsn_from_env())
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


async def _fetch_records_by_kind(kind: str) -> list[dict[str, Any]]:
    """Every row of one kind in `intake_records` (ADR-0046 s5's generic
    record store), including the rows intake refused (bad schema, no label
    at all). Each row carries `intake_decision`, intake's own stored verdict
    -- allowed, reason, decision_id, provisional -- so the pane can list a
    refusal with the reason intake gave. Intake's refusal is not re-litigated
    here; what IS re-decided, fresh, for the rows intake admitted is whether
    THIS destination's gate admits them. Intake's decision and this pane's
    decision answer different questions; the two are not expected to agree.
    `ORDER BY key` only for a stable response order across requests."""
    conn = await asyncpg.connect(store_dsn_from_env())
    try:
        rows = await conn.fetch(
            "SELECT kind, key, originator_nation, releasable_to, owning_tier, "
            "body, decision, decided_at FROM intake_records WHERE kind = $1 "
            "ORDER BY key",
            kind,
        )
    finally:
        await conn.close()

    def _intake_decision(raw: Any) -> dict[str, Any]:
        stored = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        if not isinstance(stored, dict):
            stored = {}
        return {
            "allowed": bool(stored.get("allowed")),
            "reason": stored.get("reason"),
            "decision_id": stored.get("decision_id"),
            "provisional": bool(stored.get("provisional", False)),
        }

    return [
        {
            "key": row["key"],
            "originator_nation": row["originator_nation"],
            "releasable_to": list(row["releasable_to"] or []),
            "owning_tier": row["owning_tier"],
            "body": json.loads(row["body"]),
            "decided_at": row["decided_at"].isoformat(),
            "intake_decision": _intake_decision(row["decision"]),
        }
        for row in rows
    ]


CASES_LIMIT = 50


async def _fetch_cases(asset_id: str) -> list[dict[str, Any]]:
    """The cortex cases our forwarder opened for one asset: delivered ledger
    rows that carry a case_id, newest first, at most CASES_LIMIT. The four
    episode columns are NULL on rows recorded before they existed, so such
    a row never matches an asset and is simply absent."""
    conn = await asyncpg.connect(store_dsn_from_env())
    try:
        rows = await conn.fetch(
            'SELECT "route", "case_id", "episode_id", "event_id", "asset_id", '
            '"component", "fault_code", "first_recorded_at" '
            'FROM "egress_delivered_events" '
            "WHERE \"outcome\" = 'delivered' AND \"case_id\" IS NOT NULL "
            'AND "asset_id" = $1 ORDER BY "first_recorded_at" DESC LIMIT $2',
            asset_id, CASES_LIMIT,
        )
    finally:
        await conn.close()
    return [
        {
            "route": row["route"],
            "case_id": row["case_id"],
            "episode_id": row["episode_id"],
            "event_id": row["event_id"],
            "asset_id": row["asset_id"],
            "component": row["component"],
            "fault_code": row["fault_code"],
            "delivered_at": row["first_recorded_at"].isoformat(),
        }
        for row in rows
    ]


# --- ADR-0058 slice 3a: the disposition on /cases, and /reports/states ------
#
# READ ONLY. Everything below issues SELECTs and nothing else; the pane holds
# no workflow state (ADR-0046 decision 1). The joins are the spec's 3.2:
#   ledger -> case   by `case_id`
#   case -> action   by the action kind's declared `case_ref` pointer, NEVER
#                    by the intake key's prefix (the key's format is the
#                    consumer's, not ours)
#   action -> completion by the completion kind's declared `completes_ref`
# A kind that declares no pointer is not joined, and the response names it.

KINDS_DIR = Path(os.getenv(
    "OPENDDIL_EGRESS_KINDS_DIR", str(Path(__file__).parent / "kind-schemas")))
STATES_EPISODE_LIMIT = 200

# PROVISIONAL completion-body fields: both wait on iagent's completion
# contract (the same status as `completes_ref`'s name). `outcome` is one of
# done / cancelled / deferred; `episode_id` is the episode id OpenDDIL sent,
# carried back beside iagent's case id (a check, never the join).
COMPLETION_OUTCOME_POINTER = "/outcome"
COMPLETION_EPISODE_POINTER = "/episode_id"
COMPLETION_OUTCOMES = ("done", "cancelled", "deferred")

# The action body's own fields, as the intake fixtures shape it (an action
# record's `work_order.task` and its `approval_chain`). These are read by
# fixed name, not by declared pointer, because no declaration names them yet;
# a body without them yields None for that field, never an error.
ACTION_OPTION_POINTER = "/work_order/task"
ACTION_CHAIN_POINTER = "/approval_chain"


def _kind_context() -> tuple[dict[str, Any], set[str]]:
    """(declarations, action kind names). Action kinds are the intake
    config's entry kinds when that config loads, plus every kind declaring a
    `case_ref`. A missing directory or config gives what could be read: the
    disposition then reads "none", never an error on the cases route."""
    declarations: dict[str, Any] = {}
    try:
        from kinds import load_declarations  # noqa: PLC0415
        if KINDS_DIR.is_dir():
            declarations = load_declarations(KINDS_DIR)
    except Exception as exc:  # noqa: BLE001
        log.warning("kind declarations not loaded; dispositions read none: %s", exc)
    action_kinds = {k for k, d in declarations.items() if d.case_ref}
    config_path = os.getenv("OPENDDIL_EGRESS_INTAKE_CONFIG")
    if config_path:
        try:
            action_kinds |= _intake_config_kinds(config_path)
        except Exception as exc:  # noqa: BLE001
            log.warning("intake config not loaded for dispositions: %s", exc)
    return declarations, action_kinds


def _intake_config_kinds(path: str) -> set[str]:
    """The `kind` of each entry in the intake config, and nothing else.

    Read here rather than through `intake.load_intake_config`: importing
    intake would ship its producer into this role, and this role writes no
    topic (produces.yaml, `egress-pane-api: topics: []`). Intake validates
    the file itself and refuses to start on a bad one; this only needs the
    names."""
    text = Path(path).read_text(encoding="utf-8")
    if Path(path).suffix.lower() in (".yaml", ".yml"):
        import yaml  # noqa: PLC0415
        raw = yaml.safe_load(text)
    else:
        raw = json.loads(text)
    if not isinstance(raw, list):
        raise ValueError(f"{path}: must be a list of entries")
    return {e["kind"] for e in raw
            if isinstance(e, Mapping) and isinstance(e.get("kind"), str) and e["kind"]}


def _pointer_path(pointer: str) -> list[str]:
    """An RFC 6901 pointer as a Postgres text[] path (`body #>> path`)."""
    if pointer == "":
        return []
    return [seg.replace("~1", "/").replace("~0", "~") for seg in pointer.split("/")[1:]]


def _resolve(body: Any, pointer: str) -> Any:
    """The value at `pointer` in `body`, or None when any step is absent."""
    cur = body
    for seg in _pointer_path(pointer):
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        elif isinstance(cur, list) and seg.isdigit() and int(seg) < len(cur):
            cur = cur[int(seg)]
        else:
            return None
    return cur


def _json_value(raw: Any) -> Any:
    return json.loads(raw) if isinstance(raw, (str, bytes)) else raw


def _decision_of(raw: Any) -> dict[str, Any]:
    stored = _json_value(raw)
    if not isinstance(stored, dict):
        stored = {}
    allowed = bool(stored.get("allowed"))
    return {"allowed": allowed, "reason": None if allowed else (stored.get("reason") or "unknown")}


def _intake_row(row: Any) -> dict[str, Any]:
    return {
        "kind": row["kind"],
        "key": row["key"],
        "body": _json_value(row["body"]),
        "decision": _decision_of(row["decision"]),
        "decided_at": row["decided_at"],
    }


async def _fetch_rows_by_pointer(
    kind: str, pointer: str, values: list[str], *, extra_pointer: str | None = None,
    extra_values: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Rows of one kind whose body, at `pointer`, holds one of `values`
    (or, when given, whose body at `extra_pointer` holds one of
    `extra_values`). The SELECT is the join; nothing is matched on the key."""
    if not values and not extra_values:
        return []
    conn = await asyncpg.connect(store_dsn_from_env())
    try:
        if extra_pointer is None:
            rows = await conn.fetch(
                "SELECT kind, key, body, decision, decided_at FROM intake_records "
                "WHERE kind = $1 AND (body #>> $2::text[]) = ANY($3::text[])",
                kind, _pointer_path(pointer), values,
            )
        else:
            rows = await conn.fetch(
                "SELECT kind, key, body, decision, decided_at FROM intake_records "
                "WHERE kind = $1 AND ((body #>> $2::text[]) = ANY($3::text[]) "
                "OR (body #>> $4::text[]) = ANY($5::text[]))",
                kind, _pointer_path(pointer), values,
                _pointer_path(extra_pointer), extra_values or [],
            )
    finally:
        await conn.close()
    return [_intake_row(r) for r in rows]


async def _fetch_actions_for_cases(
    declarations: Mapping[str, Any], action_kinds: set[str], case_ids: list[str],
) -> list[dict[str, Any]]:
    """Every intake row, of a kind declaring `case_ref`, whose body names one
    of `case_ids`. Each row is re-checked in Python against the same
    pointer, so a row the store returned that does not name a case is never
    joined."""
    out: list[dict[str, Any]] = []
    for kind in sorted(action_kinds):
        decl = declarations.get(kind)
        if decl is None or not decl.case_ref:
            continue  # not joinable: named by the caller, never matched on key
        for row in await _fetch_rows_by_pointer(kind, decl.case_ref, case_ids):
            case_id = _resolve(row["body"], decl.case_ref)
            if isinstance(case_id, str) and case_id in case_ids:
                row["case_id"] = case_id
                out.append(row)
    return out


def _disposition_of(row: dict[str, Any]) -> dict[str, Any]:
    """The work-order option and stage of an action row. No declaration
    names these fields yet, so they are read by fixed name (see
    ACTION_OPTION_POINTER) and are None when the body lacks them."""
    option = _resolve(row["body"], ACTION_OPTION_POINTER)
    chain = _resolve(row["body"], ACTION_CHAIN_POINTER)
    stage = None
    if isinstance(chain, list) and chain and isinstance(chain[-1], dict):
        stage = chain[-1].get("role")
    return {"option": option, "stage": stage, "kind": row["kind"], "key": row["key"]}


def attach_dispositions(
    cases: list[dict[str, Any]], actions: list[dict[str, Any]],
    unjoinable_kinds: list[str],
) -> list[dict[str, Any]]:
    """Add `disposition`, `decided_at`, `decision` and `disposition_state` to
    each case, leaving every existing key alone. The latest action for a case
    is its max `decided_at`. A refusal is `refused` with its reason; a case
    with no joined action is `none` (the absence named), or `unjoinable` when
    an action kind exists that declares no `case_ref`."""
    by_case: dict[str, dict[str, Any]] = {}
    for row in actions:
        cur = by_case.get(row["case_id"])
        if cur is None or row["decided_at"] > cur["decided_at"]:
            by_case[row["case_id"]] = row
    for case in cases:
        row = by_case.get(case["case_id"])
        if row is None:
            case["disposition"] = None
            case["decided_at"] = None
            case["decision"] = {"allowed": False, "reason": None}
            case["disposition_state"] = "unjoinable" if unjoinable_kinds else "none"
            continue
        decision = row["decision"]
        case["disposition"] = _disposition_of(row)
        case["decided_at"] = row["decided_at"].isoformat()
        case["decision"] = dict(decision)
        case["disposition_state"] = "admitted" if decision["allowed"] else "refused"
    return cases


async def _cases_with_dispositions(asset_id: str) -> list[dict[str, Any]]:
    cases = await _fetch_cases(asset_id)
    declarations, action_kinds = _kind_context()
    case_ids = sorted({c["case_id"] for c in cases})
    actions = (await _fetch_actions_for_cases(declarations, action_kinds, case_ids)
               if case_ids else [])
    unjoinable = sorted(k for k in action_kinds
                        if declarations.get(k) is None or not declarations[k].case_ref)
    return attach_dispositions(cases, actions, unjoinable)


async def _fetch_ledger_by_episode(episode_ids: list[str]) -> list[dict[str, Any]]:
    """Ledger rows (held and delivered) for these episodes. SELECT only."""
    conn = await asyncpg.connect(store_dsn_from_env())
    try:
        rows = await conn.fetch(
            'SELECT "route", "event_id", "outcome", "http_status", "case_id", '
            '"episode_id", "first_recorded_at", "recorded_at" '
            'FROM "egress_delivered_events" WHERE "episode_id" = ANY($1::text[]) '
            'ORDER BY "first_recorded_at"',
            episode_ids,
        )
    finally:
        await conn.close()
    return [dict(r) for r in rows]


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def _completion_record(row: dict[str, Any]) -> dict[str, Any]:
    outcome = _resolve(row["body"], COMPLETION_OUTCOME_POINTER)
    carried = _resolve(row["body"], COMPLETION_EPISODE_POINTER)
    return {
        "kind": row["kind"], "key": row["key"], "completes": row["completes"],
        "decided_at": _iso(row["decided_at"]),
        "allowed": row["decision"]["allowed"], "reason": row["decision"]["reason"],
        "outcome": outcome if outcome in COMPLETION_OUTCOMES else None,
        "episode_id_carried": carried if isinstance(carried, str) else None,
    }


async def build_states(episode_ids: list[str]) -> dict[str, Any]:
    """What this tier's hub owns, per episode id (spec 3.1: queued for send,
    sent, case opened, released, work recorded). One read per table, not per
    episode. An unmatched completion (one naming a release key this tier does
    not hold) is listed against the episode whose id it carries, as a listing
    only; it is never matched by asset or time."""
    declarations, action_kinds = _kind_context()
    ledger = await _fetch_ledger_by_episode(episode_ids) if episode_ids else []
    case_ids = sorted({r["case_id"] for r in ledger if r["case_id"]})
    actions = (await _fetch_actions_for_cases(declarations, action_kinds, case_ids)
               if case_ids else [])
    released_keys = {a["key"] for a in actions}

    completion_kinds = sorted(k for k, d in declarations.items() if d.completes_ref)
    completions: list[dict[str, Any]] = []
    for kind in completion_kinds:
        rows = await _fetch_rows_by_pointer(
            kind, declarations[kind].completes_ref, sorted(released_keys),
            extra_pointer=COMPLETION_EPISODE_POINTER, extra_values=episode_ids)
        for row in rows:
            row["completes"] = _resolve(row["body"], declarations[kind].completes_ref)
            completions.append(row)

    episodes: dict[str, Any] = {}
    for eid in episode_ids:
        rows = [r for r in ledger if r["episode_id"] == eid]
        eps_cases = {r["case_id"] for r in rows if r["case_id"]}
        released = [a for a in actions if a["case_id"] in eps_cases]
        held_keys = {a["key"] for a in released}
        matched = [_completion_record(c) for c in completions if c["completes"] in held_keys]
        unmatched = [_completion_record(c) for c in completions
                     if c["completes"] not in released_keys
                     and _resolve(c["body"], COMPLETION_EPISODE_POINTER) == eid]
        episodes[eid] = {
            "ledger": [{
                "route": r["route"], "event_id": r["event_id"], "outcome": r["outcome"],
                "http_status": r["http_status"], "case_id": r["case_id"],
                "recorded_at": _iso(r["recorded_at"]),
                "first_recorded_at": _iso(r["first_recorded_at"]),
                # Not stored: the forwarder only logs a case_id mismatch
                # (forwarder.py, the `case_id_mismatch` warning); the ledger
                # has no column for it and none is added. Always false here.
                "case_id_mismatch": False,
            } for r in rows],
            "released": [{
                "kind": a["kind"], "key": a["key"], "case_id": a["case_id"],
                "decided_at": _iso(a["decided_at"]),
                "allowed": a["decision"]["allowed"], "reason": a["decision"]["reason"],
            } for a in released],
            "completion": {"declared": bool(completion_kinds), "records": matched},
            "unmatched_completions": unmatched,
        }
    return {"episodes": episodes}


def build_decisions(destination: str, kind: str | None = None) -> dict[str, Any]:
    """One destination's whole answer, decided record by record through the
    real gate. Raises `AuthzUnavailable` when the PDP could not be asked at
    all — the caller must surface that as an outage, not as 14 refusals.

    No `kind`: exactly today's asset_logistics_status path, byte-identical
    to before `kind` existed. A `kind`: `intake_records`, filtered to that
    kind, through the SAME gate call -- `EgressGate.for_destination` takes
    `kind` itself and `decide` refuses `kind_not_accepted` on its own when
    the destination's `accepts` does not list it; nothing here re-implements
    that check.

    On the kind path a row intake refused is listed, not dropped: it is
    emitted `allowed: False` with intake's own stored reason and decision_id
    and `refused_by: "intake"`, and `gate.decide` is never called for it.
    A row intake admitted is re-decided by THIS destination's gate and
    carries `refused_by: "gate"` when that refuses, `None` when it admits.
    """
    gate = EgressGate.for_destination(destination, kind=kind)  # the one PDP call

    if kind is None:
        wire_records = asyncio.run(_fetch_all_records())
        records = []
        admitted = 0
        for label in wire_records:
            asset_id = label["asset_id"]
            decision = gate.decide(
                {"originator_nation": label["originator_nation"],
                 "releasable_to": label["releasable_to"]},
                key=asset_id,
            )
            if decision.allowed:
                admitted += 1
            records.append({
                "asset_id": asset_id,
                "originator_nation": label["originator_nation"],
                "releasable_to": label["releasable_to"],
                "allowed": decision.allowed,
                # null on admit — `allowed` already says so, and "admit" is
                # not a refusal reason a reader should have to filter back
                # out.
                "reason": None if decision.allowed else decision.reason,
                "decision_id": decision.decision_id,
            })
        return {
            "destination": destination,
            "policy_version": gate.policy_version,
            "corpus_version": gate.corpus_version,
            "admitted": admitted,
            "refused": len(records) - admitted,
            "records": records,
        }

    kind_records = asyncio.run(_fetch_records_by_kind(kind))
    records = []
    admitted = 0
    for row in kind_records:
        intake = row.get("intake_decision")
        intake_refused = intake is not None and not intake["allowed"]
        body = row["body"]
        if intake_refused:
            # Intake's refusal stands as stored: not re-decided here.
            allowed = False
            reason = intake["reason"] or "unknown"
            decision_id = intake["decision_id"]
            refused_by = "intake"
            provisional = bool(intake["provisional"])
        else:
            decision = gate.decide(
                {"originator_nation": row["originator_nation"],
                 "releasable_to": row["releasable_to"]},
                key=row["key"],
            )
            allowed = decision.allowed
            reason = None if allowed else decision.reason
            decision_id = decision.decision_id
            refused_by = None if allowed else "gate"
            provisional = False
        if allowed:
            admitted += 1
        records.append({
            "key": row["key"],
            # Display convenience only, read from `body` -- never used to
            # decide the record. See the module docstring.
            "asset_id": body.get("asset_id") if isinstance(body, dict) else None,
            "originator_nation": row["originator_nation"],
            "releasable_to": row["releasable_to"],
            "allowed": allowed,
            "reason": reason,
            "decision_id": decision_id,
            "refused_by": refused_by,
            "provisional": provisional,
            "owning_tier": row["owning_tier"],
            "decided_at": row["decided_at"],
            "body": body,
        })
    return {
        "destination": destination,
        "kind": kind,
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

    def _get_cases(self, parsed) -> None:
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        asset_id = (params.get("asset_id") or [""])[0]
        if not asset_id:
            self._send_json(400, {"error": "asset_id required"})
            return
        try:
            cases = asyncio.run(_cases_with_dispositions(asset_id))
        except Exception as exc:  # noqa: BLE001 — a 500 with a body beats a hang
            log.exception("unhandled error building /cases asset_id=%s", asset_id)
            self._send_json(500, {"error": "internal_error", "detail": str(exc)})
            return
        self._send_json(200, {"cases": cases})

    def _get_report_states(self, parsed) -> None:
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        ids = [i for i in params.get("episode_id", []) if i]
        if not ids:
            self._send_json(400, {"error": "episode_id required"})
            return
        if len(set(ids)) > STATES_EPISODE_LIMIT:
            self._send_json(400, {"error": f"at most {STATES_EPISODE_LIMIT} episode_id"})
            return
        try:
            payload = asyncio.run(build_states(sorted(set(ids))))
        except Exception as exc:  # noqa: BLE001 - a 500 with a body beats a hang
            log.exception("unhandled error building /reports/states")
            self._send_json(500, {"error": "internal_error", "detail": str(exc)})
            return
        self._send_json(200, payload)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if parsed.path == "/cases":
            self._get_cases(parsed)
            return
        if parsed.path == "/reports/states":
            self._get_report_states(parsed)
            return
        if parsed.path != "/decisions":
            self._send_json(404, {"error": "unknown path"})
            return

        params = urllib.parse.parse_qs(parsed.query)
        destination = (params.get("destination") or [DEFAULT_DESTINATION])[0]
        kind = (params.get("kind") or [None])[0]

        try:
            payload = build_decisions(destination, kind=kind)
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
    # R6b: both tables this process reads must exist before it serves a
    # single request — a missing one would otherwise surface as a 500 on
    # the first `/decisions` call instead of a named startup refusal.
    asyncio.run(require_tables(
        store_dsn_from_env(),
        ["asset_logistics_status", "intake_records", "egress_delivered_events"]))
    log.info("egress pane-api listening on :%s", LISTEN_PORT)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), PaneApi).serve_forever()


if __name__ == "__main__":
    main()
