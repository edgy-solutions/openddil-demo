"""The timeline of a filed report, built from rows already read (ADR-0058
slice 3a, DESIGN-2026-11-10 section 3.1).

Pure functions: no I/O, no Electric, no pane call. pep.py reads the episode
rows through its cached shapes and calls the egress pane once, then hands
both to `build_reports`. That keeps the state rules testable without a
server and keeps this module incapable of writing anything.

NO COMBINED STATUS. A report is a list of `states`, each with its own source
and time. Nothing in this module computes an overall badge, and nothing says
"pending": a state that cannot be read says why (`read in 3b`, `no source`,
`door at the hub, unreachable`).
"""
from __future__ import annotations

import datetime
from typing import Any, Mapping

DOOR_OK = "ok"
DOOR_UNREACHABLE = "unreachable"
DOOR_NOT_CONFIGURED = "not_configured"

READ_IN_3B = {"read": "read in 3b"}


def _iso(dt: datetime.datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def _parse(value: Any) -> datetime.datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip().replace(" ", "T", 1)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


def interval_holds(episode: Mapping[str, Any], when: datetime.datetime | None) -> bool:
    """`[detected_at, cleared_at)`; an open episode has no end."""
    if when is None:
        return False
    start, end = episode["detected_at"], episode["cleared_at"]
    return start <= when and (end is None or when < end)


def _triple(item: Mapping[str, Any]) -> tuple[Any, Any, Any]:
    return (item.get("asset_id"), item.get("component"), item.get("fault_code"))


def _pane_blocks(pane_faults: list[Any]) -> dict[tuple, Mapping[str, Any]]:
    """The pane's fault blocks, by their (asset_id, component, fault_code)."""
    return {_triple(b): b for b in pane_faults if isinstance(b, Mapping)}


def join_ledger(
    episodes: list[dict[str, Any]], pane_faults: list[Any],
    listed_triples: set[tuple],
) -> tuple[dict[tuple[str, str], list[dict[str, Any]]], list[dict[str, Any]]]:
    """Ledger rows per episode, and the rows that fit none.

    The join key is the fault identity both sides carry, (asset_id,
    component, fault_code): the ledger's own `episode_id` is the egress
    side's id and is never compared with cm-service's. `episodes` is EVERY
    episode this tier holds (not only the listed ones), so a row that
    belongs to another filer's episode of the same fault is left to it and
    not reported as unmatched here. A triple held by one episode joins
    directly: a held row delivered after the close still belongs to it.
    Where several episodes hold it, a row joins the one whose interval holds
    its `first_recorded_at`; a row that fits none is returned in the second
    value, never dropped. A block whose triple no LISTED episode holds is
    skipped."""
    by_triple: dict[tuple, list[dict[str, Any]]] = {}
    for ep in episodes:
        by_triple.setdefault(_triple(ep), []).append(ep)
    joined: dict[tuple[str, str], list[dict[str, Any]]] = {}
    unmatched: list[dict[str, Any]] = []
    for triple, block in _pane_blocks(pane_faults).items():
        if triple not in listed_triples:
            continue
        holders = by_triple.get(triple, [])
        for row in block.get("ledger") or []:
            if len(holders) == 1:
                target = holders[0]
            else:
                when = _parse(row.get("first_recorded_at"))
                target = next((e for e in holders if interval_holds(e, when)), None)
            if target is None:
                unmatched.append(dict(row))
            else:
                joined.setdefault(
                    (target["episode_id"], _iso(target["detected_at"])), []).append(row)
    return joined, unmatched


def _filed(ep: Mapping[str, Any], viewer: str | None) -> dict[str, Any]:
    times = [t for t in (_parse(s.get("reported_at")) for s in ep["sources"]) if t]
    detail: dict[str, Any] = {"sources": len(ep["sources"])}
    people = [s.get("reported_by") for s in ep["sources"] if s.get("reported_by")]
    # A filer sees only their own subject on their own list; a supervisor's
    # list names every filer.
    detail["reported_by"] = [p for p in people if viewer is None or p == viewer]
    if not ep["open"]:
        detail["cleared_at"] = _iso(ep["cleared_at"])
        detail["cleared_by"] = ep["cleared_by"]
        detail["resolution"] = ep["resolution"]
    return {"state": "filed", "source": "episode",
            "at": _iso(min(times) if times else ep["detected_at"]), "detail": detail}


def _ledger_states(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return [{"state": "queued for send", "source": "ledger", "at": None,
                 "detail": {"ledger": "no row"}}]
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.get("outcome") == "delivered":
            out.append({"state": "sent", "source": "ledger", "at": row.get("recorded_at"),
                        "detail": {"recorded_at": row.get("recorded_at"),
                                   "http_status": row.get("http_status")}})
            if row.get("case_id"):
                detail: dict[str, Any] = {"case_id": row["case_id"]}
                if row.get("case_id_mismatch"):
                    detail["case_id_mismatch"] = True
                out.append({"state": "case opened", "source": "ledger",
                            "at": row.get("recorded_at"), "detail": detail})
            else:
                # Delivered, and the reply that names the case has not been
                # recorded: named, and not the same as "case opened, nothing
                # proposed yet".
                out.append({"state": "sent, awaiting reply", "source": "ledger",
                            "at": row.get("recorded_at"), "detail": {}})
        else:
            out.append({"state": "queued for send", "source": "ledger",
                        "at": row.get("first_recorded_at"),
                        "detail": {"ledger": "held", "held": "retries exhausted"}})
    return out


def _released_states(released: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for rec in released:
        detail: dict[str, Any] = {"kind": rec.get("kind"), "key": rec.get("key"),
                                  "case_id": rec.get("case_id"),
                                  "allowed": bool(rec.get("allowed"))}
        if not rec.get("allowed"):
            detail["reason"] = rec.get("reason")
        out.append({"state": "released", "source": "intake",
                    "at": rec.get("decided_at"), "detail": detail})
    return out


def _work_states(completion: Mapping[str, Any],
                 egress_ids: set[str]) -> list[dict[str, Any]]:
    if not completion.get("declared"):
        return [{"state": "work recorded", "source": "none", "at": None,
                 "detail": {"read": "no source"}}]
    out = []
    for rec in completion.get("records") or []:
        outcome = rec.get("outcome")
        state = ("work recorded" if outcome in (None, "done")
                 else f"work recorded: {outcome}")
        detail: dict[str, Any] = {"kind": rec.get("kind"), "key": rec.get("key"),
                                  "completes": rec.get("completes"),
                                  "allowed": bool(rec.get("allowed"))}
        if not rec.get("allowed"):
            detail["reason"] = rec.get("reason")
        carried = rec.get("episode_id_carried")
        if carried is not None and carried not in egress_ids:
            detail["episode_mismatch"] = True
        out.append({"state": state, "source": "intake",
                    "at": rec.get("decided_at"), "detail": detail})
    return out


def build_reports(
    listed: list[dict[str, Any]], all_episodes: list[dict[str, Any]], *,
    door: str, pane: Mapping[str, Any] | None, viewer: str | None,
) -> dict[str, Any]:
    """The timeline of every listed episode, newest first.

    `door` is how the hub's pane answered: `ok` (with `pane` the parsed
    body), `unreachable` or `not_configured`. When it is not `ok` the
    hub-owned states are not drawn as queued; one state names the door."""
    listed = sorted(listed, key=lambda e: e["detected_at"], reverse=True)
    pane_faults = (pane or {}).get("faults") or []
    blocks = _pane_blocks(pane_faults)
    joined, unmatched_ledger = (
        join_ledger(all_episodes, pane_faults, {_triple(e) for e in listed})
        if door == DOOR_OK else ({}, []))
    unmatched_given: set[tuple] = set()
    reports = []
    for ep in listed:
        eid = ep["episode_id"]
        states = [_filed(ep, viewer)]
        triple = _triple(ep)
        block = blocks.get(triple) or {}
        unmatched: list[dict[str, Any]] = []
        if door == DOOR_UNREACHABLE:
            states.append({"state": "door at the hub, unreachable", "source": "hub",
                           "at": None, "detail": {}})
        elif door == DOOR_NOT_CONFIGURED:
            states.append({"state": "door not configured at this tier", "source": "hub",
                           "at": None, "detail": {}})
        else:
            rows = joined.get((eid, _iso(ep["detected_at"])), [])
            states += _ledger_states(rows)
        states.append({"state": "proposed", "source": "iagent", "at": None,
                       "detail": dict(READ_IN_3B)})
        states.append({"state": "approved", "source": "iagent", "at": None,
                       "detail": dict(READ_IN_3B)})
        if door == DOOR_OK:
            own_rows = joined.get((eid, _iso(ep["detected_at"])), [])
            held_case_ids = {r.get("case_id") for r in own_rows if r.get("case_id")}
            egress_ids = {r.get("episode_id") for r in own_rows if r.get("episode_id")}
            states += _released_states(
                [r for r in block.get("released") or [] if r.get("case_id") in held_case_ids])
            states += _work_states(block.get("completion") or {"declared": False}, egress_ids)
            if triple not in unmatched_given:
                # An unmatched completion is listed once per fault, on the
                # newest listed episode that holds it.
                unmatched_given.add(triple)
                unmatched = list(block.get("unmatched_completions") or [])
        reports.append({
            "episode_id": eid, "detected_at": _iso(ep["detected_at"]),
            "asset_id": ep["asset_id"], "owning_tier": ep["owning_tier"],
            "component": ep["component"],
            "fault_code": ep["fault_code"], "open": ep["open"],
            "cleared_at": _iso(ep["cleared_at"]), "cleared_by": ep["cleared_by"],
            "resolution": ep["resolution"], "states": states, "unmatched": unmatched,
        })
    return {"reports": reports, "unmatched_ledger": unmatched_ledger}
