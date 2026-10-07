"""assembler.py — turns a CM episode into one record of a declared kind
(ADR-0046, the assembler pass).

cm-service publishes the whole `AsMaintainedRecord` for an asset on
`asset-cm-state` every time anything about it changes. Nothing on that
topic is shaped like a kind a destination has agreed to receive: a kind's
schema wants one record per (asset, component, fault_code) EPISODE, with
its own field names at its own pointers, carrying a picture built from
several OTHER sources (hub postgres, the parts-availability topic). This
module is the one place that gap is closed — pure functions that do the
shaping, plus an injectable runner that feeds them from Kafka and postgres
the same way `routes.run_once` feeds `gate.py` from Kafka and the PDP.

WHAT "OPEN" MEANS HERE, AND WHY THERE IS NO STATUS FIELD TO READ
The real `AsMaintainedRecord.manual_discrepancies` (cm-service
`src/as_maintained/persistence_model.py`) has no resolved/status marker on
a `DiscrepancyRecord` — not in the dataclass, not in the wire proto
(`openddil-contracts/proto/openddil/configuration/v1/discrepancy.proto`),
and cm-service has no code path that ever removes an entry from that list.
An episode's only observable state is PRESENCE in `manual_discrepancies`
with a non-empty `fault_code`; there is no "resolved" to read, only
"still there" or "gone". `episodes()` below reflects exactly that: it
filters the list it is given, and a cm-state message that no longer
carries a given (component, fault_code) pair is how a resolved episode
looks on this wire, not a flag on a record that stays.

ONE PICTURE SOURCE AT A TIME, ONE RECORD SHAPE
`assemble()` is pure and synchronous: it takes an already-read `picture`
dict and already-looked-up `cm_state`/`episode` data and writes the
declared pointers. The I/O that PRODUCES a `picture` dict — the hub
postgres read and the in-memory parts-availability lookup — lives in
`read_asset`/`PartsBook` below and is injected, the same seam
`EgressGate.for_destination` gives `main.py` for the PDP.

RESTART RE-EMITS, ON PURPOSE
The runner's de-duplication key is `(record key, sorted source event_ids)`,
held only in this process's memory. A restart starts that memory empty, so
every still-open episode is assembled and produced again on the next
cm-state message for its asset — with an UNCHANGED record key, because the
key is a pure function of (kind, owning_tier, asset, component,
fault_code, first-observed time), none of which restarting changes (the
time is read from the cm-state record, not from this process). That is a revision of a
key a downstream consumer has already seen, not a duplicate record under a
new key, which is exactly what an upsert-by-key destination (the gate's
sink, and whatever reads it) needs: re-applying the same key is a no-op in
meaning even though it is a re-send on the wire.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal as signal_module
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

import delivery
import pointer
from kinds import Declarations
from startup import require_topics

log = logging.getLogger("egress.assembler")

POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN", "postgres://postgres:password@postgres-hq:5432/openddil")


# --- episodes -----------------------------------------------------------

@dataclass(frozen=True)
class Episode:
    """One open (asset, component, fault_code) episode, read off a
    cm-state message's `manual_discrepancies`."""

    asset: str
    component: str
    fault_code: str
    detected_at_ns: int
    sources: tuple[Mapping[str, Any], ...]


# The assembler's only trigger is a CM discrepancy episode: `episodes()`
# below reads `manual_discrepancies`, never any other wire. ADR-0046 §1's
# other value, "lifecycle_transition", names a different kind of episode
# (a lifecycle state change) this process does not build — a kind that
# declares `trigger` always gets this constant from here, never a guess
# based on what a given deployment's config happens to be running.
TRIGGER_CM_DISCREPANCY = "cm_discrepancy"


def episodes(cm_state: Mapping[str, Any]) -> list[Episode]:
    """The open discrepancies with a non-empty `fault_code`.

    An empty `fault_code` is the unkeyed manual-discrepancy path (ADR-0018
    §Amendment 2026-08-15) — not an episode, never assembled. There is no
    separate "resolved" test here: see the module docstring. An entry
    simply not present is the only way a resolved episode is represented on
    this wire."""
    asset = cm_state.get("asset_id", "")
    out: list[Episode] = []
    for disc in cm_state.get("manual_discrepancies", []) or []:
        fault_code = disc.get("fault_code") or ""
        if not fault_code:
            continue
        out.append(Episode(
            asset=asset,
            component=disc.get("component", ""),
            fault_code=fault_code,
            detected_at_ns=disc.get("detected_at_ns", 0) or 0,
            sources=tuple(disc.get("sources", []) or []),
        ))
    return out


def record_key(
    kind: str, owning_tier: str, asset: str, component: str, fault_code: str,
    detected_at_ns: int,
) -> str:
    """The identity of one OCCURRENCE of a fault: one uuid5 per (kind,
    owning_tier, asset, component, fault_code, first-observed time). A
    second source inside an open occurrence keeps that time, so it is a
    revision under the same key. A fault that clears and reappears, or a
    re-run after the store is emptied, is a new occurrence and a new key.
    Still deterministic and re-derivable from the cm-state record alone — a
    restart, or a second process reading the same episode, computes the
    identical key without consulting any store."""
    seed = f"{kind}|{owning_tier}|{asset}|{component}|{fault_code}|{detected_at_ns}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _rfc3339(ns: int) -> str:
    """Nanoseconds since the epoch -> RFC 3339 UTC, second precision. The
    detected time on a `DiscrepancyRecord` is `detected_at_ns`; everywhere
    else on this wire that carries a timestamp as a string uses this same
    shape, so a kind's `observed_at` pointer gets a value every other
    timestamp field in the system already looks like."""
    seconds = (ns or 0) / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rfc3339_from_dt(dt: datetime | None) -> str | None:
    """A postgres `timestamptz` column's own value -> the same RFC 3339
    shape `_rfc3339` produces from nanoseconds. `None` (a NULL column, or a
    row this process never read) stays `None` — never defaulted to `now()`,
    which would be the assembler's clock standing in for a source's own
    timestamp."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_rfc3339(value: str) -> datetime:
    """An RFC 3339 datetime string carrying an explicit offset (or a
    trailing `Z`, swapped for `+00:00` — `fromisoformat` wants the latter)
    -> an aware `datetime`. Raises `ValueError` on anything
    `fromisoformat` cannot parse, or on a value that parses but carries no
    offset at all (a naive datetime back out) — a config's `basis.
    observed_at` must say "when", including relative to what."""
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError(f"{value!r} carries no UTC offset (a naive datetime)")
    return dt


def _label_from_cm_state(cm_state: Mapping[str, Any]) -> dict[str, Any] | None:
    """The label to write at the kind's `label` pointer, straight from the
    cm-state record — never derived, never defaulted to a tier guess. `None`
    means write nothing at all: the gate then reads an absent mapping at
    that pointer and refuses the record as unlabelled, which is the visible
    failure this is supposed to produce when upstream has not labelled the
    asset."""
    nation = cm_state.get("originator_nation") or None
    releasable = [n for n in (cm_state.get("releasable_to") or []) if n]
    if not nation and not releasable:
        return None
    return {"originator_nation": nation, "releasable_to": releasable}


def _properties_at(schema: Mapping[str, Any], ptr: str) -> frozenset[str]:
    """The property names a schema declares at `ptr`, by walking
    `properties` one reference token at a time. RFC 6901 pointers describe
    INSTANCE paths; for a plain nested-object schema (every picture pointer
    in this system is one) the schema path mirrors it exactly, one
    `properties` lookup per token. Any token that does not resolve —
    because the schema does not constrain that far, not because it is
    malformed — yields no names, which `assemble` reads as "this schema
    names nothing here", not as an error."""
    node: Any = schema
    for tok in pointer.tokens(ptr):
        if not isinstance(node, Mapping):
            return frozenset()
        properties = node.get("properties")
        if not isinstance(properties, Mapping) or tok not in properties:
            return frozenset()
        node = properties[tok]
    if not isinstance(node, Mapping):
        return frozenset()
    properties = node.get("properties")
    return frozenset(properties.keys()) if isinstance(properties, Mapping) else frozenset()


def _provenance_entries(
    cm_state: Mapping[str, Any], episode: Episode, picture: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """`{row_key, observed_at?}` for every source `picture` was actually
    read from, in the fixed order the rule specifies. `observed_at` is
    always that source's OWN timestamp, read off `cm_state`/`picture`,
    never `now()` — this function takes no clock at all. A source this
    process did not read (no postgres row, no spare resolved) contributes
    no entry; a source it did read but that carries no timestamp column
    (or a NULL one) contributes an entry with no `observed_at`."""
    entries: list[dict[str, Any]] = [{"row_key": f"asset_cm_state:{episode.asset}"}]
    last_observed_ns = cm_state.get("last_observed_at_ns")
    if last_observed_ns:
        entries[0]["observed_at"] = _rfc3339(last_observed_ns)

    if picture.get("readiness") is not None:
        entry: dict[str, Any] = {"row_key": f"telemetry_latest_state:{episode.asset}"}
        observed_at = picture.get("readiness_observed_at")
        if observed_at:
            entry["observed_at"] = observed_at
        entries.append(entry)

    if picture.get("rollup") is not None:
        entry = {"row_key": f"asset_logistics_status:{episode.asset}"}
        observed_at = picture.get("rollup_observed_at")
        if observed_at:
            entry["observed_at"] = observed_at
        entries.append(entry)

    spare = picture.get("spare")
    part_ref = spare.get("part_ref") if isinstance(spare, Mapping) else None
    if part_ref:
        for spares_entry in picture.get("spares") or []:
            site = spares_entry.get("site")
            if not site:
                continue
            entry = {"row_key": f"parts-availability:{site}:{part_ref}"}
            observed_at = spares_entry.get("as_of")
            if observed_at:
                entry["observed_at"] = observed_at
            entries.append(entry)

    return entries


def _source_entries(episode: Episode) -> list[dict[str, Any]]:
    """`episode.sources`, each entry additionally carrying `observed_at`
    (RFC 3339 UTC of its own `reported_at_ns`) and `row_ref` (its own
    `event_id`), alongside whatever fields cm-service already put there.
    Purely additive, and per-entry: a source missing `reported_at_ns` gets
    no `observed_at`; one missing `event_id` gets no `row_ref` — never
    defaulted from another entry or from this process's own clock."""
    entries: list[dict[str, Any]] = []
    for source in episode.sources:
        entry = dict(source)
        reported_at_ns = source.get("reported_at_ns")
        if reported_at_ns:
            entry["observed_at"] = _rfc3339(reported_at_ns)
        event_id = source.get("event_id")
        if event_id:
            entry["row_ref"] = event_id
        entries.append(entry)
    return entries


def assemble(
    kind: str,
    decl: Declarations,
    schema: Mapping[str, Any],
    cm_state: Mapping[str, Any],
    episode: Episode,
    picture: Mapping[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """One episode -> one record of `kind`, at exactly the pointers `decl`
    names. Pure: no I/O, no clock reads (`now` is passed in, used only if a
    future declaration needs "assembled at" — today's declared fields do
    not), no knowledge of any kind's field names beyond what `decl` says.

    `picture` is the FULL candidate picture — whatever `{readiness,
    lifecycle, factors, rollup, spare}` sections the caller could produce —
    filtered here down to only the sections `schema` names under the
    `picture` pointer's `properties`. A section the schema requires that
    this process could not fill is simply absent from the filtered result;
    the gate's schema check is what turns that into a visible
    `schema_invalid` refusal, not a guess made here.
    """
    owning_tier = cm_state.get("edge_id") or cm_state.get("region_id") or ""

    out: dict[str, Any] = {}
    pointer.set(out, decl.key, record_key(
        kind, owning_tier, episode.asset, episode.component, episode.fault_code,
        episode.detected_at_ns))

    label = _label_from_cm_state(cm_state)
    if label is not None:
        pointer.set(out, decl.label, label)

    pointer.set(out, decl.owning_tier, owning_tier)
    pointer.set(out, decl.episode.asset, episode.asset)
    pointer.set(out, decl.episode.component, episode.component)
    pointer.set(out, decl.episode.fault_code, episode.fault_code)

    if decl.trigger:
        pointer.set(out, decl.trigger, TRIGGER_CM_DISCREPANCY)

    if decl.observed_at:
        pointer.set(out, decl.observed_at, _rfc3339(episode.detected_at_ns))

    if decl.sources:
        pointer.set(out, decl.sources, _source_entries(episode))

    if decl.provenance:
        pointer.set(out, decl.provenance, _provenance_entries(cm_state, episode, picture))

    if decl.picture:
        allowed = _properties_at(schema, decl.picture)
        filtered = {k: v for k, v in picture.items() if k in allowed}
        if filtered:
            pointer.set(out, decl.picture, filtered)

    return out


# --- the picture: parts book + asset reading ------------------------------

class PartsBook:
    """The latest parts-availability record for every (part_ref, site) this
    process has consumed, in memory only — "the latest records are kept in
    memory from that topic" (no postgres table backs this topic). Fed by
    `ingest` from the parts topic; read by `lookup` while assembling a
    spare-picture section.

    THE NEAREST-SITE RING IS NOT HERE, DELIBERATELY. Which sites are "near"
    a given owning tier is logistics-sim's siting configuration, never a
    field this module computes itself. Nearness arrives ALREADY DECIDED, on
    each parts-availability record's own `nearest_site_with_stock` (ADR-0046
    §4, `config.spare_picture`) — `lookup` reports stock at every site this
    process has ever seen a record for, and separately reads the owning
    tier's own record for which of those (if any) its configured ring names
    as nearest; this module still does not invent a ring of its own.
    """

    def __init__(self) -> None:
        self._by_ref: dict[str, dict[str, dict[str, Any]]] = {}

    def ingest(self, record: Mapping[str, Any]) -> None:
        part_ref = record.get("part_ref")
        site = record.get("site")
        if not part_ref or not site:
            return
        entry: dict[str, Any] = {
            "item": record.get("item"),
            "on_hand": record.get("on_hand", 0),
        }
        # Carried only when THIS record has them — a record that never
        # mentions `lead_time_days` must not make a site look like it has a
        # lead time of zero, and a record whose `lead_time_days` genuinely
        # IS zero must not be told apart from "never carried" by `or`/`get`
        # defaulting, hence the explicit membership check. Same discipline
        # for `nearest_site_with_stock`: an older publisher's record that
        # never carries it must not be told apart from one that carries it
        # as JSON null (see `lookup`'s `nearest_spare` handling below).
        for field_name in ("lead_time_days", "source", "nearest_site_with_stock"):
            if field_name in record:
                entry[field_name] = record[field_name]
        # The record's time: Contract B's `observed_at_ns` when present,
        # else the legacy `as_of` -- a compacted topic keeps pre-change
        # records around until the next publisher sweep, so both shapes
        # must be accepted. Stored under this entry's own `as_of` key
        # either way, so the output event field (`as_of`, via
        # `_rfc3339`) is unchanged regardless of which shape fed it.
        if "observed_at_ns" in record:
            entry["as_of"] = record["observed_at_ns"]
        elif "as_of" in record:
            entry["as_of"] = record["as_of"]
        self._by_ref.setdefault(part_ref, {})[site] = entry

    def lookup(self, part_ref: str, owning_tier: str) -> dict[str, Any] | None:
        sites = self._by_ref.get(part_ref)
        if not sites:
            return None
        item = next((v["item"] for v in sites.values() if v.get("item") is not None), None)
        on_hand = {site: v.get("on_hand", 0) for site, v in sites.items()}
        spares: list[dict[str, Any]] = []
        for site in sorted(sites):
            entry = sites[site]
            spare_entry: dict[str, Any] = {"site": site, "on_hand": entry.get("on_hand", 0)}
            if "lead_time_days" in entry:
                spare_entry["lead_time_days"] = entry["lead_time_days"]
            if "source" in entry:
                # Renamed on the EVENT only — the parts record on the wire
                # keeps `source`; this module's output field is
                # `lead_time_source` (not to be confused with cm-state's
                # unrelated `sources[]` provenance list).
                spare_entry["lead_time_source"] = entry["source"]
            if "as_of" in entry:
                spare_entry["as_of"] = _rfc3339(entry["as_of"])
            spares.append(spare_entry)

        result: dict[str, Any] = {
            "part_ref": part_ref,
            "item": item,
            "on_hand_here": on_hand.get(owning_tier),
            "on_hand": on_hand,
            "spares": spares,
        }

        # `nearest_spare`: read ONLY off the owning tier's own record, never
        # computed here (ADR-0046 §4) — see the class docstring. The owning
        # tier's record missing, or present but lacking the field (an older
        # publisher), each leave `nearest_spare` off `result` entirely:
        # "unknown" is not the same claim as "no site has stock" (null).
        owning_entry = sites.get(owning_tier)
        if owning_entry is not None and "nearest_site_with_stock" in owning_entry:
            nearest_site = owning_entry["nearest_site_with_stock"]
            if nearest_site is None:
                result["nearest_spare"] = None
            else:
                named_row = next((s for s in spares if s["site"] == nearest_site), None)
                # The named site has no spares[] row of its own (this
                # process has never seen a parts-availability record for
                # it) — omit, the same "unknown is not no-stock" rule.
                if named_row is not None:
                    result["nearest_spare"] = dict(named_row)

        return result


def _installed_part_ref(cm_state: Mapping[str, Any], component: str) -> str | None:
    """The part installed in the episode's component slot. `installed[]`
    entries are `InstalledCiRecord {slot_id, ci_id, installed_at_ns}`
    (cm-service `persistence_model.py`); `component` on a `DiscrepancyRecord`
    IS a BOM slot_id (same file, same comment), so matching on `slot_id`
    against the episode's `component` is not a guess — it is the same slot
    identifier on both sides. `ci_id` is the installed part's reference."""
    for entry in cm_state.get("installed", []) or []:
        if entry.get("slot_id") == component:
            ci_id = entry.get("ci_id")
            return ci_id or None
    return None


ReadAsset = Callable[[str], Awaitable[Mapping[str, Any] | None]]


async def read_asset(asset_id: str) -> dict[str, Any] | None:
    """Default `read_asset`: one asyncpg connection per call, exactly the
    `pane_api.py` pattern (`_fetch_all_records`) — a fresh connection asked
    once per request rather than a held pool, because this is invoked once
    per assembled record, not on a hot per-row path.

    Returns the readiness + rollup/factors sections a `Picture` can use, or
    `None` sections where hub postgres holds no row for this asset (a
    section the assembler could not fill, not a guessed default)."""
    import asyncpg  # noqa: PLC0415 — only this function needs it

    conn = await asyncpg.connect(POSTGRES_DSN)
    try:
        telemetry = await conn.fetchrow(
            "SELECT operational_status, reporting_status, last_sample_at "
            "FROM telemetry_latest_state WHERE asset_id = $1", asset_id,
        )
        logistics = await conn.fetchrow(
            "SELECT overall_severity, constraining_factors, computed_at "
            "FROM asset_logistics_status WHERE asset_id = $1", asset_id,
        )
    finally:
        await conn.close()

    readiness = None
    readiness_observed_at = None
    if telemetry is not None:
        readiness = {
            "operational_status": telemetry["operational_status"],
            "reporting_status": telemetry["reporting_status"],
        }
        # `last_sample_at` is the row's own domain timestamp (the latest
        # sample's instant, projector-populated from the event's own
        # provenance.sample_time) — not `updated_at`, which is the row's
        # last-write housekeeping column, not a source timestamp.
        readiness_observed_at = _rfc3339_from_dt(telemetry["last_sample_at"])

    rollup = None
    factors = None
    rollup_observed_at = None
    if logistics is not None:
        rollup = {"overall_severity": logistics["overall_severity"]}
        raw_factors = logistics["constraining_factors"]
        if isinstance(raw_factors, str):
            factors = json.loads(raw_factors) if raw_factors else []
        else:
            factors = raw_factors if raw_factors is not None else []
        # `computed_at` is when logistics-sim computed this severity row
        # (projector-populated from the status message's own `computed_at`)
        # — again not `updated_at`.
        rollup_observed_at = _rfc3339_from_dt(logistics["computed_at"])

    return {
        "readiness": readiness, "rollup": rollup, "factors": factors,
        "readiness_observed_at": readiness_observed_at,
        "rollup_observed_at": rollup_observed_at,
    }


@dataclass(frozen=True)
class Designation:
    """One asset's battle-condition designation, from an assembler route's
    config: whether it is mission-essential, and why — "why" being which
    rule set it and when (ADR-0046 §1: `basis` is `{rule, observed_at}`,
    never bare prose). Never defaulted — an asset with no `Designation`
    gets no `mission_essential`/`basis` at all, not a guessed `False`."""

    mission_essential: bool
    basis_rule: str
    basis_observed_at: str


def _lifecycle_name(cm_state: Mapping[str, Any]) -> str | None:
    """`cm_state["lifecycle"]` the way a kind's `string|null` pointer wants
    it, never cm-service's wire shape as-is.

    Hub `asset-cm-state` carries this as proto3 JSON, which renders an enum
    as its bare integer, not its name — postgres and every kind schema want
    the name (`LIFECYCLE_ACTIVE`, not `2`). A string already in that shape
    passes through unchanged (both are real on this wire: a producer that
    already translated needs no second pass). `None` stays `None`. An int
    this process's proto build has no name for becomes `None` — one episode
    missing a lifecycle is not worth refusing the whole record for — logged
    once, naming the asset and the value, rather than raised."""
    value = cm_state.get("lifecycle")
    if value is None or isinstance(value, str):
        return value

    from openddil.configuration.v1 import as_maintained_pb2  # noqa: PLC0415 — only this branch needs it

    try:
        return as_maintained_pb2.LifecycleState.Name(value)
    except ValueError:
        log.warning(
            "unknown lifecycle value %r for asset %s", value, cm_state.get("asset_id"))
        return None


async def build_picture(
    cm_state: Mapping[str, Any],
    episode: Episode,
    owning_tier: str,
    *,
    read_asset: ReadAsset,
    parts: PartsBook,
    part_refs: Mapping[str, str] | None = None,
    designations: Mapping[str, Designation] | None = None,
) -> dict[str, Any]:
    """The full candidate picture for one episode — `{readiness, lifecycle,
    factors, rollup, spare, spares, nearest_spare, battle_condition}` —
    before `assemble` filters it down to the sections a kind's schema
    actually names. A section this process could not fill (no postgres row,
    no installed part for the slot, no designation) is simply absent from
    the returned dict; `assemble` never sees a guessed value for it.
    `spares`/`nearest_spare` are the exception to "absent when unfilled":
    once a part ref resolves at all, both are written even when the parts
    book has no rows for it (`spares: []`, `nearest_spare: null`) — see
    `PartsBook.lookup`.

    `readiness_observed_at`/`rollup_observed_at` also ride along at the top
    level when `read_asset` supplied them — not picture sections themselves
    (no real kind names them), just how `assemble` learns each source's own
    timestamp for `provenance[]` without reading postgres itself."""
    sections: dict[str, Any] = {"lifecycle": _lifecycle_name(cm_state)}

    asset_id = cm_state.get("asset_id")
    reading = await read_asset(asset_id) if asset_id else None
    rollup: Mapping[str, Any] | None = None
    if reading:
        if reading.get("readiness") is not None:
            sections["readiness"] = reading["readiness"]
            if reading.get("readiness_observed_at"):
                sections["readiness_observed_at"] = reading["readiness_observed_at"]
        if reading.get("rollup") is not None:
            rollup = reading["rollup"]
            sections["rollup"] = rollup
            if reading.get("rollup_observed_at"):
                sections["rollup_observed_at"] = reading["rollup_observed_at"]
        if reading.get("factors") is not None:
            sections["factors"] = reading["factors"]

    battle_condition: dict[str, Any] = {}
    if rollup is not None and rollup.get("overall_severity") is not None:
        battle_condition["overall_severity"] = rollup["overall_severity"]
    designation = (designations or {}).get(asset_id) if asset_id else None
    if designation is not None:
        battle_condition["mission_essential"] = designation.mission_essential
        battle_condition["basis"] = {
            "rule": designation.basis_rule, "observed_at": designation.basis_observed_at}
    if battle_condition:
        sections["battle_condition"] = battle_condition

    # The installed CI's own reference first; then the part the deployment
    # says fills this slot. The first that the parts records know wins.
    candidates = (_installed_part_ref(cm_state, episode.component),
                  (part_refs or {}).get(episode.component))
    for part_ref in candidates:
        if not part_ref:
            continue
        spare = parts.lookup(part_ref, owning_tier)
        if spare is not None:
            spares = spare.pop("spares")
            has_nearest_spare = "nearest_spare" in spare
            nearest_spare = spare.pop("nearest_spare", None)
            sections["spare"] = spare
            # Always set, even `[]` — a part the parts records know always
            # gets a spares section, empty or not.
            sections["spares"] = spares
            if has_nearest_spare:
                sections["nearest_spare"] = nearest_spare
            break
    # No candidate the parts records know (nothing installed, no slot map
    # entry, or no record for the part yet, e.g. before the first parts
    # sweep after a start): neither `spares` nor `nearest_spare` is written.
    # `nearest_spare: null` would say "no site has stock", a value nobody
    # reported; a kind that requires the keys refuses the event instead.

    return sections


# --- the runner ------------------------------------------------------------

class AssemblerConfigError(ValueError):
    """The assembler config file failed to load. The message names the
    entry, the same convention `routes.RouteError` uses."""


@dataclass(frozen=True)
class AssemblerRoute:
    """One row of `OPENDDIL_ASSEMBLER_CONFIG`: a trigger topic (cm-state) to
    read episodes from, an optional parts topic to keep `PartsBook` fed, a
    kind to assemble into, and the output topic to produce assembled
    records to.

    `part_refs` maps a component (a slot id) to the part reference the
    parts records use for it, as (component, part_ref) pairs. It is the
    deployment's statement of which part fills a slot, used when the CI
    installed in the slot does not itself name a part the parts records
    carry (an empty `ci_id` is common: a slot known to the baseline with
    no CI recorded)."""

    name: str
    kind: str
    trigger_topic: str
    output_topic: str
    parts_topic: str | None = None
    part_refs: tuple[tuple[str, str], ...] = ()
    # One `Designation` per asset_id this route's deployment has declared
    # mission-essential (or explicitly not), as (asset_id, Designation)
    # pairs — `dict(...)` at the point of use, the same convention
    # `part_refs` uses.
    battle_condition: tuple[tuple[str, "Designation"], ...] = ()


def _entry_label(entry: object, index: int) -> str:
    if isinstance(entry, Mapping) and entry.get("name") is not None:
        return repr(entry["name"])
    return f"entry #{index}"


def load_assembler_config(
    path: str | os.PathLike, known_kinds: Iterable[str],
) -> list[AssemblerRoute]:
    """Load `OPENDDIL_ASSEMBLER_CONFIG`: a JSON list of `{name, kind,
    trigger_topic, parts_topic?, output_topic, part_refs?}` entries. Names must be
    unique and non-empty; `kind` must be one whose declarations name an
    `owning_tier` and an `episode` (`known_kinds`). A
    bad file raises `AssemblerConfigError` naming the entry — the caller
    (this module's `main`) turns that into exit code 2 rather than starting
    with an entry it cannot run."""
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, list):
        raise AssemblerConfigError(f"{path}: must be a JSON list of entries")

    known = set(known_kinds)
    seen: set[str] = set()
    routes: list[AssemblerRoute] = []
    for index, entry in enumerate(raw):
        label = _entry_label(entry, index)
        if not isinstance(entry, Mapping):
            raise AssemblerConfigError(f"{label}: entry must be a JSON object")

        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise AssemblerConfigError(f"{label}: 'name' must be a non-empty string")
        if name in seen:
            raise AssemblerConfigError(f"{label}: duplicate name")
        seen.add(name)

        kind = entry.get("kind")
        if kind not in known:
            raise AssemblerConfigError(
                f"{label}: kind {kind!r} is not declared for assembly "
                "(x-openddil needs owning_tier and episode)")

        missing = [f for f in ("trigger_topic", "output_topic") if f not in entry]
        if missing:
            raise AssemblerConfigError(f"{label}: missing required field(s) {missing}")

        part_refs = entry.get("part_refs", {})
        if not isinstance(part_refs, Mapping) or not all(
                isinstance(k, str) and k and isinstance(v, str) and v
                for k, v in part_refs.items()):
            raise AssemblerConfigError(
                f"{label}: 'part_refs' must map non-empty component strings to "
                "non-empty part reference strings")

        raw_battle_condition = entry.get("battle_condition", {})
        if not isinstance(raw_battle_condition, Mapping):
            raise AssemblerConfigError(f"{label}: 'battle_condition' must be a JSON object")
        battle_condition: list[tuple[str, Designation]] = []
        for asset_id, designated in raw_battle_condition.items():
            if not isinstance(asset_id, str) or not asset_id:
                raise AssemblerConfigError(
                    f"{label}: 'battle_condition' keys must be non-empty asset id strings")
            if not isinstance(designated, Mapping):
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}] must be a JSON object")
            mission_essential = designated.get("mission_essential")
            if not isinstance(mission_essential, bool):
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].mission_essential must be a "
                    "bool, not coerced from another type")
            basis = designated.get("basis")
            if isinstance(basis, str):
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis must now be a JSON "
                    "object {rule, observed_at}, not a bare string")
            if not isinstance(basis, Mapping):
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis must be a JSON object "
                    "{rule, observed_at}")
            extra = sorted(set(basis) - {"rule", "observed_at"})
            if extra:
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis has unknown key(s) {extra}")
            basis_rule = basis.get("rule")
            if not isinstance(basis_rule, str) or not basis_rule:
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis.rule must be a "
                    "non-empty string")
            basis_observed_at_raw = basis.get("observed_at")
            if not isinstance(basis_observed_at_raw, str) or not basis_observed_at_raw:
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis.observed_at must be a "
                    "non-empty RFC 3339 datetime string")
            try:
                basis_dt = _parse_rfc3339(basis_observed_at_raw)
            except ValueError as exc:
                raise AssemblerConfigError(
                    f"{label}: battle_condition[{asset_id!r}].basis.observed_at is not a "
                    f"valid RFC 3339 datetime with a UTC offset: {basis_observed_at_raw!r} "
                    f"({exc})") from exc
            battle_condition.append((asset_id, Designation(
                mission_essential=mission_essential,
                basis_rule=basis_rule,
                basis_observed_at=_rfc3339_from_dt(basis_dt))))

        routes.append(AssemblerRoute(
            name=name, kind=kind, trigger_topic=entry["trigger_topic"],
            output_topic=entry["output_topic"], parts_topic=entry.get("parts_topic"),
            part_refs=tuple(sorted(part_refs.items())),
            battle_condition=tuple(battle_condition),
        ))
    return routes


@dataclass
class _RouteState:
    route: AssemblerRoute
    declarations: Declarations
    schema: Mapping[str, Any]
    parts: PartsBook = field(default_factory=PartsBook)
    # (record key) -> sorted tuple of source event_ids this process last
    # produced for it. In memory only — see the module docstring on why a
    # restart re-emitting every open episode once is correct here, not a bug.
    last_produced: dict[str, tuple[str, ...]] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=lambda: {
        "records": 0, "revisions": 0, "sources": 0,
    })


def _source_ids(episode: Episode) -> tuple[str, ...]:
    return tuple(sorted(s.get("event_id", "") for s in episode.sources))


async def _produce_episode(
    state: _RouteState,
    cm_state: Mapping[str, Any],
    episode: Episode,
    *,
    read_asset: ReadAsset,
    now: datetime,
    produce: Callable[[str, bytes, bytes], None],
    postgres_retry: Sequence[float] = (0.5, 1.0, 2.0, 4.0, 8.0),
) -> None:
    """Assemble one episode and produce it if, and only if, (key, sorted
    source event_ids) differs from what this process last produced for that
    key — a second source on an already-open episode is a revision with the
    SAME key, not a new record."""
    owning_tier = cm_state.get("edge_id") or cm_state.get("region_id") or ""
    key = record_key(
        state.route.kind, owning_tier, episode.asset, episode.component, episode.fault_code,
        episode.detected_at_ns)
    source_ids = _source_ids(episode)
    if state.last_produced.get(key) == source_ids:
        return

    # Bounded retry with backoff on a postgres error. The offset this
    # episode's message arrived on is not committed until this returns
    # without raising — see the caller.
    attempt = 0
    while True:
        try:
            picture = await build_picture(
                cm_state, episode, owning_tier,
                read_asset=read_asset, parts=state.parts,
                part_refs=dict(state.route.part_refs),
                designations=dict(state.route.battle_condition),
            )
            break
        except Exception:  # noqa: BLE001 — retried, then re-raised
            if attempt >= len(postgres_retry):
                raise
            delay = postgres_retry[attempt]
            log.warning(
                "postgres error building picture for %s (attempt %d); retrying in %.1fs",
                key, attempt + 1, delay,
            )
            await asyncio.sleep(delay)
            attempt += 1

    record = assemble(
        state.route.kind, state.declarations, state.schema, cm_state, episode, picture, now,
    )
    payload = json.dumps(record, separators=(",", ":")).encode("utf-8")
    produce(state.route.output_topic, payload, key.encode("utf-8"))

    is_revision = key in state.last_produced
    state.last_produced[key] = source_ids
    state.counters["revisions" if is_revision else "records"] += 1
    state.counters["sources"] += len(source_ids)


async def handle_cm_state_message(
    state: _RouteState,
    cm_state: Mapping[str, Any],
    *,
    read_asset: ReadAsset,
    now: datetime,
    produce: Callable[[str, bytes, bytes], None],
) -> None:
    """Every open episode in one cm-state message, assembled and produced
    (or skipped as an unchanged duplicate) in turn."""
    for episode in episodes(cm_state):
        await _produce_episode(state, cm_state, episode, read_asset=read_asset, now=now, produce=produce)


def log_counters(states: Iterable[_RouteState]) -> None:
    """One line per route: `records` (distinct keys ever produced),
    `revisions` (same key, new sources), `sources` (source entries carried
    across every record produced). Logged at shutdown and every 60s by
    `main`."""
    for state in states:
        log.info("assembler route=%s %s", state.route.name, json.dumps(state.counters, sort_keys=True))


# --- process wiring ---------------------------------------------------------
# Everything below is the real runner: a Kafka consumer, `kinds.py`'s
# declarations and schemas, and `asyncpg`. None of it is exercised by the
# unit tests, which inject `read_asset`/`produce`/a `PartsBook` directly
# against `handle_cm_state_message` — the same injection seam
# `routes.run_once` gives `main.py` for the PDP and the broker.

CONFIG_PATH = os.getenv("OPENDDIL_ASSEMBLER_CONFIG")
KINDS_DIR = Path(os.getenv(
    "OPENDDIL_EGRESS_KINDS_DIR", str(Path(__file__).parent / "kind-schemas")))
BROKERS = os.getenv("OPENDDIL_EGRESS_BROKERS", "redpanda-hq:19092")
GROUP = os.getenv("OPENDDIL_ASSEMBLER_GROUP", "egress-assembler")
POLL_TIMEOUT = float(os.getenv("OPENDDIL_EGRESS_POLL_TIMEOUT", "1.0"))
COUNTER_LOG_INTERVAL_S = 60.0

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [assembler] %(message)s",
    stream=sys.stdout,
)

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s — draining and stopping", signum)
    _running = False


def _load_raw_schemas(directory: Path) -> dict[str, Mapping[str, Any]]:
    """Just the JSON, for `_properties_at` — this module never needs
    `jsonschema` itself (that import stays `kinds.py`'s alone)."""
    if not directory.is_dir():
        return {}
    out = {}
    for path in sorted(directory.glob("*.schema.json")):
        out[path.name[: -len(".schema.json")]] = json.loads(path.read_text())
    return out


def _decode(payload: bytes) -> dict:
    return json.loads(payload.decode("utf-8"))


def _make_produce(producer) -> Callable[[str, bytes, bytes], None]:
    """The `produce` callable `_produce_episode` is given: one call, one
    message, confirmed delivered before returning.

    Separated from `_main_async` so it is exercised directly against a fake
    producer rather than only through a live `confluent_kafka.Producer` —
    this one function is the entire fix for the bug where a produce that
    silently failed still looked like success: raises `delivery.
    DeliveryFailed` if the broker never confirms, which reaches
    `_produce_episode` before it touches `last_produced`/the counters, and
    reaches the runner's loop before `consumer.commit`, so neither one
    advances past a record that was never actually delivered."""

    def produce(topic: str, value: bytes, key: bytes) -> None:
        delivery.send_one(producer, topic, value, key)

    return produce


async def _main_async() -> int:
    from confluent_kafka import Consumer, Producer  # noqa: PLC0415

    from kinds import load_declarations, load_kinds  # noqa: PLC0415

    if not CONFIG_PATH:
        log.error("FATAL: OPENDDIL_ASSEMBLER_CONFIG is not set")
        return 2

    known = load_kinds(KINDS_DIR) if KINDS_DIR.is_dir() else {}
    declarations_map = load_declarations(KINDS_DIR) if KINDS_DIR.is_dir() else {}
    assemblable = [k for k, d in declarations_map.items()
                   if k in known and d.owning_tier and d.episode]
    try:
        routes = load_assembler_config(CONFIG_PATH, assemblable)
    except Exception as exc:  # noqa: BLE001 — a bad config must not start the runner
        log.error("FATAL: assembler config failed to load: %s", exc)
        return 2

    schemas = _load_raw_schemas(KINDS_DIR)

    states = {
        route.name: _RouteState(
            route=route, declarations=declarations_map[route.kind],
            schema=schemas.get(route.kind, {}),
        )
        for route in routes
    }

    topics: set[str] = set()
    trigger_states: dict[str, list[_RouteState]] = {}
    parts_states: dict[str, list[_RouteState]] = {}
    for state in states.values():
        topics.add(state.route.trigger_topic)
        trigger_states.setdefault(state.route.trigger_topic, []).append(state)
        if state.route.parts_topic:
            topics.add(state.route.parts_topic)
            parts_states.setdefault(state.route.parts_topic, []).append(state)

    signal_module.signal(signal_module.SIGTERM, _stop)
    signal_module.signal(signal_module.SIGINT, _stop)

    # R6b: every trigger/parts topic consumed and every output topic
    # produced to must exist before the first poll.
    if routes:
        from confluent_kafka.admin import AdminClient  # noqa: PLC0415
        wanted_topics = sorted(topics | {r.output_topic for r in routes})
        require_topics(AdminClient({"bootstrap.servers": BROKERS}), wanted_topics)

    consumer = Consumer({
        "bootstrap.servers": BROKERS,
        "group.id": GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    producer = Producer({"bootstrap.servers": BROKERS})
    consumer.subscribe(sorted(topics))

    produce = _make_produce(producer)

    last_counter_log = asyncio.get_event_loop().time()
    try:
        while _running:
            msg = consumer.poll(POLL_TIMEOUT)
            if msg is not None and not msg.error():
                topic = msg.topic()
                try:
                    record = _decode(msg.value())
                except Exception as exc:  # noqa: BLE001
                    log.warning("undecodable message on %s: %s", topic, exc)
                    record = None

                if record is not None:
                    for state in parts_states.get(topic, []):
                        state.parts.ingest(record)
                    for state in trigger_states.get(topic, []):
                        # Not committed until produced — a postgres error
                        # that exhausts the retry budget, or a produce whose
                        # delivery `produce()` above never confirms, raises
                        # out of here and this message's offset is never
                        # committed.
                        await handle_cm_state_message(
                            state, record, read_asset=read_asset,
                            now=datetime.now(timezone.utc), produce=produce,
                        )
                # Commit after the message is handled, whichever branch.
                consumer.commit(msg, asynchronous=False)
            elif msg is not None:
                log.warning("consumer error: %s", msg.error())

            now_monotonic = asyncio.get_event_loop().time()
            if now_monotonic - last_counter_log >= COUNTER_LOG_INTERVAL_S:
                log_counters(states.values())
                last_counter_log = now_monotonic
    finally:
        log_counters(states.values())
        producer.flush(10)
        consumer.close()
    return 0


def main() -> int:
    return asyncio.run(_main_async())


if __name__ == "__main__":
    raise SystemExit(main())
