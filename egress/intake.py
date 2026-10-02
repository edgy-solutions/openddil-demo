"""intake.py — generic artifact intake (ADR-0046 v2 §5, §6).

A destination with intake returns artifacts of a declared kind; this
process polls them. Every artifact is decided against ONE rule, in this
exact order:

  1. `schema_invalid` if the artifact fails its own kind's schema.
  2. unchanged-by-hash skip: the same (kind, key) with the same
     `body_sha256` already in `intake_records` is not re-decided and
     nothing is re-logged or re-published — only a CHANGED body is a
     revision.
  3. the record it answers must be known (`answered_record_unknown`), or
     not yet decidable if this process has not caught up with the answers
     topic yet (deferred, not refused, retried next poll);
  4. its label must equal that answered record's label (`label_mismatch`);
  5. every approver subject must resolve and be entitled to the label, by
     the SAME predicate the read path applies (`approver_unresolved`,
     `approver_unentitled`, `approvers_missing`);
  6. `on_behalf_of`, when configured and present, is trusted only from a
     source destination whose own gate answer carries
     `trust_on_behalf_of: true`, and is then resolved and entitled exactly
     like an approver (`on_behalf_of_untrusted`, plus the approver
     reasons);
  7. otherwise admit.

NO CODE NAMES A SPECIFIC DESTINATION, KIND, FIELD OR ENDPOINT. Every one of
those comes from `OPENDDIL_EGRESS_INTAKE_CONFIG` and from a kind's own
`x-openddil` declarations block (`kinds.py`) — the same discipline
`assembler.py` and `routes.py` already follow, for the same reason: a
second place that knows a destination's name is a second place that can
drift from the first.

PURE DECISION, INJECTED I/O. `decide_artifact` below takes an already-
fetched artifact, an already-looked-up `existing_sha256`, an in-memory
`AnsweredMap`, and a `gate_for` callable in place of a live PDP call — the
same injection seam `assembler.handle_cm_state_message` gives `read_asset`
and `produce`, and `routes.run_once` gives the consumer/producer/PDP.
`run_poll` is the one layer up: one HTTP fetch, one artifact loop, one
store, one producer — still entirely injectable, still with no Kafka,
Postgres or urllib import of its own. Everything below the "process
wiring" banner is the real runner and is not exercised by the unit tests,
the same split `assembler.py` and `main.py` use.

`AuthzUnavailable` IS NOT A REFUSAL. An artifact whose approver or
on_behalf_of lookup hits a PDP outage gets no decision and no store write
at all — `gate.py`'s own rule, repeated here rather than reinvented.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import signal as signal_module
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

import delivery
import pointer
from gate import AuthzUnavailable, EgressGate, Label, extract_label_at, new_decision_id
from kinds import Declarations

log = logging.getLogger("egress.intake")

POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN", "postgres://postgres:password@postgres-hq:5432/openddil")

# --- reasons ------------------------------------------------------------
# Distinct operational events, same discipline as gate.py's REASON_* — see
# its module docstring on why a refusal without a reason is just a drop
# with better manners.

REASON_SCHEMA_INVALID = "schema_invalid"
REASON_LABEL_MISMATCH = "label_mismatch"
REASON_ANSWERED_RECORD_UNKNOWN = "answered_record_unknown"
REASON_APPROVERS_MISSING = "approvers_missing"
REASON_APPROVER_UNRESOLVED = "approver_unresolved"
REASON_APPROVER_UNENTITLED = "approver_unentitled"
REASON_ON_BEHALF_OF_UNTRUSTED = "on_behalf_of_untrusted"
ADMIT = "admit"

# What `decide_artifact` returns besides an actual decision — neither is
# loggable or storable, and both mean "try this artifact again next poll".
DECIDED = "decided"
SKIPPED_UNCHANGED = "skipped_unchanged"
DEFERRED = "deferred"


def canonical_sha256(obj: Any) -> str:
    """SHA-256 over the canonical JSON encoding (sorted keys, compact) —
    the same two choices (`sort_keys=True`, `separators=(",", ":")`) every
    other content hash in this codebase makes, so two processes hashing the
    same artifact always agree."""
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


# --- configuration --------------------------------------------------------

class IntakeConfigError(ValueError):
    """The intake config file failed to load. The message names the
    entry — the same convention `AssemblerConfigError`/`RouteError` use."""


@dataclass(frozen=True)
class PollSpec:
    url: str
    interval_s: float
    items_pointer: str  # "" = the response body itself is the list


@dataclass(frozen=True)
class AnswersSpec:
    topic: str
    kind: str
    ref_pointer: str  # in the artifact: which answered record it answers
    id_pointer: str   # in the answered record: its own id


@dataclass(frozen=True)
class ApproversSpec:
    array_pointer: str
    subject_field: str


@dataclass(frozen=True)
class IntakeEntry:
    name: str
    source_destination: str
    kind: str
    poll: PollSpec
    answers: AnswersSpec
    approvers: ApproversSpec
    onward_topic: str
    on_behalf_of_pointer: str | None = None


def _entry_label(entry: object, index: int) -> str:
    if isinstance(entry, Mapping) and entry.get("name") is not None:
        return repr(entry["name"])
    return f"entry #{index}"


def _load_config_document(path: str | os.PathLike) -> Any:
    """JSON or YAML, by file extension — the assembler's own config is
    JSON-only (`load_assembler_config`'s `json.loads`); this loader is
    intake's own, since the spec asks this one entry point to take either.
    A `.yaml`/`.yml` path with PyYAML not installed is a config error
    naming the reason, not a confusing JSON parse failure on YAML text."""
    text = Path(path).read_text(encoding="utf-8")
    suffix = Path(path).suffix.lower()
    if suffix in (".yaml", ".yml"):
        try:
            import yaml  # noqa: PLC0415
        except ImportError as exc:
            raise IntakeConfigError(
                f"{path}: a .yaml/.yml config requires PyYAML, which is not installed"
            ) from exc
        return yaml.safe_load(text)
    return json.loads(text)


def load_intake_config(
    path: str | os.PathLike,
    declarations: Mapping[str, Declarations],
) -> list[IntakeEntry]:
    """Load `OPENDDIL_EGRESS_INTAKE_CONFIG`. A bad file raises
    `IntakeConfigError` naming the entry — the caller (`_main_async`) turns
    that into exit code 2 rather than starting with an entry it cannot
    run, exactly as `load_assembler_config` does for the assembler."""
    raw = _load_config_document(path)
    if not isinstance(raw, list):
        raise IntakeConfigError(f"{path}: must be a JSON or YAML list of entries")

    seen: set[str] = set()
    entries: list[IntakeEntry] = []
    for index, entry in enumerate(raw):
        label = _entry_label(entry, index)
        if not isinstance(entry, Mapping):
            raise IntakeConfigError(f"{label}: entry must be an object")

        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise IntakeConfigError(f"{label}: 'name' must be a non-empty string")
        if name in seen:
            raise IntakeConfigError(f"{label}: duplicate name")
        seen.add(name)

        source_destination = entry.get("source_destination")
        if not isinstance(source_destination, str) or not source_destination:
            raise IntakeConfigError(f"{label}: 'source_destination' must be a non-empty string")

        kind = entry.get("kind")
        decl = declarations.get(kind) if isinstance(kind, str) else None
        if decl is None:
            raise IntakeConfigError(f"{label}: kind {kind!r} is not declared")
        if not decl.owning_tier:
            raise IntakeConfigError(
                f"{label}: kind {kind!r} does not declare x-openddil.owning_tier")

        poll_raw = entry.get("poll")
        if not isinstance(poll_raw, Mapping):
            raise IntakeConfigError(f"{label}: 'poll' must be an object")
        url = poll_raw.get("url")
        if not isinstance(url, str) or not url:
            raise IntakeConfigError(f"{label}: 'poll.url' must be a non-empty string")
        interval_s = poll_raw.get("interval_s")
        if (not isinstance(interval_s, (int, float)) or isinstance(interval_s, bool)
                or interval_s <= 0):
            raise IntakeConfigError(f"{label}: 'poll.interval_s' must be a positive number")
        items_pointer = poll_raw.get("items_pointer")
        if not isinstance(items_pointer, str):
            raise IntakeConfigError(
                f"{label}: 'poll.items_pointer' must be a string ('' for the whole body)")

        answers_raw = entry.get("answers")
        if not isinstance(answers_raw, Mapping):
            raise IntakeConfigError(f"{label}: 'answers' must be an object")
        answers_topic = answers_raw.get("topic")
        if not isinstance(answers_topic, str) or not answers_topic:
            raise IntakeConfigError(f"{label}: 'answers.topic' must be a non-empty string")
        answers_kind = answers_raw.get("kind")
        answers_decl = declarations.get(answers_kind) if isinstance(answers_kind, str) else None
        if answers_decl is None:
            raise IntakeConfigError(f"{label}: answers.kind {answers_kind!r} is not declared")
        ref_pointer = answers_raw.get("ref_pointer")
        if not isinstance(ref_pointer, str) or not ref_pointer:
            raise IntakeConfigError(f"{label}: 'answers.ref_pointer' must be a non-empty string")
        id_pointer = answers_raw.get("id_pointer")
        if not isinstance(id_pointer, str) or not id_pointer:
            raise IntakeConfigError(f"{label}: 'answers.id_pointer' must be a non-empty string")

        approvers_raw = entry.get("approvers")
        if not isinstance(approvers_raw, Mapping):
            raise IntakeConfigError(f"{label}: 'approvers' must be an object")
        array_pointer = approvers_raw.get("array_pointer")
        if not isinstance(array_pointer, str) or not array_pointer:
            raise IntakeConfigError(f"{label}: 'approvers.array_pointer' must be a non-empty string")
        subject_field = approvers_raw.get("subject_field")
        if not isinstance(subject_field, str) or not subject_field:
            raise IntakeConfigError(f"{label}: 'approvers.subject_field' must be a non-empty string")

        on_behalf_of_pointer = entry.get("on_behalf_of_pointer")
        if on_behalf_of_pointer is not None and (
                not isinstance(on_behalf_of_pointer, str) or not on_behalf_of_pointer):
            raise IntakeConfigError(
                f"{label}: 'on_behalf_of_pointer' must be a non-empty string when present")

        onward_topic = entry.get("onward_topic")
        if not isinstance(onward_topic, str) or not onward_topic:
            raise IntakeConfigError(f"{label}: 'onward_topic' must be a non-empty string")

        entries.append(IntakeEntry(
            name=name, source_destination=source_destination, kind=kind,
            poll=PollSpec(url=url, interval_s=float(interval_s), items_pointer=items_pointer),
            answers=AnswersSpec(topic=answers_topic, kind=answers_kind,
                                 ref_pointer=ref_pointer, id_pointer=id_pointer),
            approvers=ApproversSpec(array_pointer=array_pointer, subject_field=subject_field),
            onward_topic=onward_topic, on_behalf_of_pointer=on_behalf_of_pointer,
        ))
    return entries


# --- the answered map -------------------------------------------------------

class AnsweredMap:
    """`id -> Label` for one entry's answers topic, latest record wins.

    Fed by the process wiring's consumer drain, read by `decide_artifact` —
    deliberately this simple (two methods, one flag) so a test can
    construct one directly and `.put()` into it instead of needing a
    separate fake class."""

    def __init__(self) -> None:
        self._by_id: dict[str, Label] = {}
        self.caught_up = False

    def put(self, id_value: str, label: Label) -> None:
        self._by_id[id_value] = label

    def get(self, id_value: str) -> Label | None:
        return self._by_id.get(id_value)


# --- the decision ------------------------------------------------------------

@dataclass(frozen=True)
class IntakeDecision:
    """One decision about one artifact. Logged (`INTAKE_DECISION`) and
    stored (`intake_records.decision`) whatever the outcome — the same
    "nothing is dropped silently" rule `gate.Decision` follows."""

    decision_id: str
    allowed: bool
    reason: str
    key: str
    kind: str
    source_destination: str
    answered_id: str | None
    approvers: tuple[str, ...]
    on_behalf_of: str | None
    policy_version: str = "unknown"
    corpus_version: str = "unknown"
    detail: str = ""

    def as_json(self) -> dict[str, Any]:
        return {
            "decision_id": self.decision_id,
            "allowed": self.allowed,
            "reason": self.reason,
            "key": self.key,
            "kind": self.kind,
            "source_destination": self.source_destination,
            "answered_id": self.answered_id,
            "approvers": list(self.approvers),
            "on_behalf_of": self.on_behalf_of,
            "policy_version": self.policy_version,
            "corpus_version": self.corpus_version,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class Outcome:
    """What `decide_artifact` returns. `status` is one of `DECIDED` (a real
    `decision` is attached, `label`/`owning_tier` are set for the store),
    `SKIPPED_UNCHANGED` or `DEFERRED` (neither logs nor stores anything —
    the caller just moves on)."""

    status: str
    key: str
    body_sha256: str | None = None
    label: Label | None = None
    owning_tier: str | None = None
    decision: IntakeDecision | None = None


def decide_artifact(
    entry: IntakeEntry,
    decl: Declarations,
    validator: Callable[[Mapping[str, Any]], str | None],
    artifact: Mapping[str, Any],
    *,
    existing_sha256: str | None,
    answered: AnsweredMap,
    gate_for: Callable[[str], EgressGate],
) -> Outcome:
    """Decide one artifact, per the governing text's seven steps.

    `gate_for` stands in for `EgressGate.for_destination` — it may raise
    `AuthzUnavailable`, which this function deliberately does NOT catch:
    that is "no decision at all", and the caller (`run_poll`) is the one
    place that turns it into "store nothing, retry next poll" without
    confusing it for a refusal.
    """
    raw_key = pointer.get(artifact, decl.key, default=None)
    key = raw_key if isinstance(raw_key, str) and raw_key else ""
    body_sha256 = canonical_sha256(artifact)

    if existing_sha256 is not None and existing_sha256 == body_sha256:
        return Outcome(status=SKIPPED_UNCHANGED, key=key, body_sha256=body_sha256)

    label = extract_label_at(artifact, decl.label)
    owning_tier: str | None = None
    if decl.owning_tier:
        raw_tier = pointer.get(artifact, decl.owning_tier, default=None)
        owning_tier = raw_tier if isinstance(raw_tier, str) and raw_tier else None

    versions = {"policy_version": "unknown", "corpus_version": "unknown"}

    def _note_versions(g: EgressGate) -> None:
        versions["policy_version"] = g.policy_version
        versions["corpus_version"] = g.corpus_version

    def _decided(
        allowed: bool, reason: str, *, detail: str = "",
        answered_id: str | None = None, approvers: tuple[str, ...] = (),
        on_behalf_of: str | None = None,
    ) -> Outcome:
        decision = IntakeDecision(
            decision_id=new_decision_id(), allowed=allowed, reason=reason,
            key=key, kind=entry.kind, source_destination=entry.source_destination,
            answered_id=answered_id, approvers=approvers, on_behalf_of=on_behalf_of,
            policy_version=versions["policy_version"], corpus_version=versions["corpus_version"],
            detail=detail,
        )
        return Outcome(
            status=DECIDED, key=key, body_sha256=body_sha256, label=label,
            owning_tier=owning_tier, decision=decision,
        )

    # Step 1 — schema.
    schema_error = validator(artifact)
    if schema_error is not None:
        return _decided(False, REASON_SCHEMA_INVALID, detail=schema_error[:300])

    # Step 3 — the record this artifact answers.
    raw_ref = pointer.get(artifact, entry.answers.ref_pointer, default=None)
    answered_id = raw_ref if isinstance(raw_ref, str) and raw_ref else None
    answered_label = answered.get(answered_id) if answered_id is not None else None
    if answered_label is None:
        if not answered.caught_up:
            return Outcome(status=DEFERRED, key=key, body_sha256=body_sha256)
        return _decided(
            False, REASON_ANSWERED_RECORD_UNKNOWN, answered_id=answered_id,
            detail=f"no answered record for id {answered_id!r}",
        )

    # Step 4 — label equality.
    if (label.originator_nation != answered_label.originator_nation
            or sorted(label.releasable_to) != sorted(answered_label.releasable_to)):
        return _decided(
            False, REASON_LABEL_MISMATCH, answered_id=answered_id,
            detail="artifact label does not match the answered record's label",
        )

    # Step 5 — approvers.
    raw_approvers = pointer.get(artifact, entry.approvers.array_pointer, default=[])
    subjects: list[str] = []
    if isinstance(raw_approvers, list):
        for item in raw_approvers:
            if isinstance(item, Mapping):
                subject = item.get(entry.approvers.subject_field)
                if isinstance(subject, str) and subject:
                    subjects.append(subject)
    if not subjects:
        return _decided(
            False, REASON_APPROVERS_MISSING, answered_id=answered_id,
            detail="no approver subjects declared",
        )

    label_dict = {
        "originator_nation": label.originator_nation,
        "releasable_to": list(label.releasable_to),
    }

    for subject in subjects:
        approver_gate = gate_for(subject)
        _note_versions(approver_gate)
        if not approver_gate.destination_known:
            return _decided(
                False, REASON_APPROVER_UNRESOLVED, answered_id=answered_id,
                approvers=tuple(subjects),
                detail=f"approver {subject!r} is not in the entitlements corpus",
            )
        if not approver_gate.decide(label_dict, key=key).allowed:
            return _decided(
                False, REASON_APPROVER_UNENTITLED, answered_id=answered_id,
                approvers=tuple(subjects),
                detail=f"approver {subject!r} is not entitled to this label",
            )

    # Step 6 — on_behalf_of, only when configured and present.
    on_behalf_of_value: str | None = None
    if entry.on_behalf_of_pointer:
        raw_obo = pointer.get(artifact, entry.on_behalf_of_pointer, default=None)
        if isinstance(raw_obo, str) and raw_obo:
            on_behalf_of_value = raw_obo
            source_gate = gate_for(entry.source_destination)
            _note_versions(source_gate)
            if not source_gate.trust_on_behalf_of:
                return _decided(
                    False, REASON_ON_BEHALF_OF_UNTRUSTED, answered_id=answered_id,
                    approvers=tuple(subjects), on_behalf_of=on_behalf_of_value,
                    detail=f"source {entry.source_destination!r} is not trusted for on_behalf_of",
                )
            obo_gate = gate_for(on_behalf_of_value)
            _note_versions(obo_gate)
            if not obo_gate.destination_known:
                return _decided(
                    False, REASON_APPROVER_UNRESOLVED, answered_id=answered_id,
                    approvers=tuple(subjects), on_behalf_of=on_behalf_of_value,
                    detail=f"on_behalf_of subject {on_behalf_of_value!r} is not in the "
                           "entitlements corpus",
                )
            if not obo_gate.decide(label_dict, key=key).allowed:
                return _decided(
                    False, REASON_APPROVER_UNENTITLED, answered_id=answered_id,
                    approvers=tuple(subjects), on_behalf_of=on_behalf_of_value,
                    detail=f"on_behalf_of subject {on_behalf_of_value!r} is not entitled to "
                           "this label",
                )

    # Step 7 — otherwise admit.
    return _decided(
        True, ADMIT, answered_id=answered_id, approvers=tuple(subjects),
        on_behalf_of=on_behalf_of_value,
    )


# --- one poll -----------------------------------------------------------

async def run_poll(
    entry: IntakeEntry,
    decl: Declarations,
    validator: Callable[[Mapping[str, Any]], str | None],
    *,
    fetch: Callable[[str], Any],
    store: "IntakeStore",
    answered: AnsweredMap,
    gate_for: Callable[[str], EgressGate],
    produce: Callable[[str, bytes, bytes], None],
    counters: dict[str, int],
    now: datetime,
) -> None:
    """One poll of `entry.poll.url`, decided and stored artifact by
    artifact. Entirely injected (`fetch`/`store`/`gate_for`/`produce`) —
    this is the layer the delivery-failure, authz-outage and HTTP-failure
    tests exercise directly, no real HTTP/Kafka/Postgres involved."""
    try:
        payload = fetch(entry.poll.url)
    except Exception as exc:  # noqa: BLE001 — a poll failure is a WARNING, never fatal
        log.warning("intake poll failed entry=%s url=%s: %s", entry.name, entry.poll.url, exc)
        return

    items = pointer.get(payload, entry.poll.items_pointer, default=None)
    if not isinstance(items, list):
        log.warning(
            "intake entry=%s: items_pointer %r did not resolve to a list",
            entry.name, entry.poll.items_pointer,
        )
        return

    for artifact in items:
        counters["polled"] = counters.get("polled", 0) + 1
        if not isinstance(artifact, Mapping):
            log.warning("intake entry=%s: artifact is not a JSON object, skipped", entry.name)
            continue

        raw_key = pointer.get(artifact, decl.key, default=None)
        existing_sha256 = None
        if isinstance(raw_key, str) and raw_key:
            existing_sha256 = await store.get_existing_sha256(entry.kind, raw_key)

        try:
            outcome = decide_artifact(
                entry, decl, validator, artifact,
                existing_sha256=existing_sha256, answered=answered, gate_for=gate_for,
            )
        except AuthzUnavailable as exc:
            log.warning("intake entry=%s: authz unavailable, not decided: %s", entry.name, exc)
            counters["authz_unavailable"] = counters.get("authz_unavailable", 0) + 1
            continue

        if outcome.status == SKIPPED_UNCHANGED:
            counters["skipped_unchanged"] = counters.get("skipped_unchanged", 0) + 1
            continue
        if outcome.status == DEFERRED:
            counters["deferred"] = counters.get("deferred", 0) + 1
            continue

        decision = outcome.decision
        assert decision is not None  # DECIDED always carries one
        log.info("INTAKE_DECISION %s", json.dumps(decision.as_json(), sort_keys=True))
        counters["decided"] = counters.get("decided", 0) + 1

        if decision.allowed:
            body_bytes = json.dumps(artifact, separators=(",", ":")).encode("utf-8")
            try:
                produce(entry.onward_topic, body_bytes, outcome.key.encode("utf-8"))
            except delivery.DeliveryFailed as exc:
                log.warning(
                    "intake entry=%s: delivery failed, not stored: %s", entry.name, exc)
                counters["delivery_failed"] = counters.get("delivery_failed", 0) + 1
                continue
            counters["admitted"] = counters.get("admitted", 0) + 1
        else:
            counter_key = f"refused:{decision.reason}"
            counters[counter_key] = counters.get(counter_key, 0) + 1

        await store.upsert(
            kind=entry.kind, key=outcome.key,
            originator_nation=outcome.label.originator_nation if outcome.label else None,
            releasable_to=list(outcome.label.releasable_to) if outcome.label else [],
            owning_tier=outcome.owning_tier or "",
            body=dict(artifact), body_sha256=outcome.body_sha256 or "",
            decision=decision.as_json(), decided_at=now,
        )


def log_counters(name: str, counters: Mapping[str, int]) -> None:
    """One line per entry: polled, decided, admitted, refused by reason,
    skipped_unchanged, deferred, authz_unavailable, delivery_failed —
    logged every 60s and at shutdown, the same convention
    `assembler.log_counters` uses."""
    log.info("intake entry=%s %s", name, json.dumps(dict(counters), sort_keys=True))


# --- process wiring -----------------------------------------------------
# Everything below is the real runner: urllib, a Kafka consumer/producer per
# entry, and asyncpg. None of it is exercised by the unit tests, which
# inject `fetch`/`store`/`gate_for`/`produce`/an `AnsweredMap` directly
# against `run_poll` and `decide_artifact` — the same split `assembler.py`
# and `main.py` use between their pure/injectable core and their runner.

CONFIG_PATH = os.getenv("OPENDDIL_EGRESS_INTAKE_CONFIG")
KINDS_DIR = Path(os.getenv(
    "OPENDDIL_EGRESS_KINDS_DIR", str(Path(__file__).parent / "kind-schemas")))
BROKERS = os.getenv("OPENDDIL_EGRESS_BROKERS", "redpanda-hq:19092")
COUNTER_LOG_INTERVAL_S = 60.0

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [intake] %(message)s",
    stream=sys.stdout,
)

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s — draining and stopping", signum)
    _running = False


def _decode(payload: bytes) -> dict:
    return json.loads(payload.decode("utf-8"))


def http_fetch(url: str, *, timeout: float = 10.0) -> Any:
    """GET `url` and parse the body as JSON. Any non-2xx or network error
    raises — `run_poll` is the one place that turns that into one WARNING
    and nothing else; a poll failure is never fatal here."""
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _make_produce(producer) -> Callable[[str, bytes, bytes], None]:
    def produce(topic: str, value: bytes, key: bytes) -> None:
        delivery.send_one(producer, topic, value, key)
    return produce


class IntakeStore:
    """Postgres via asyncpg, a fresh connection per call — the same
    convention `pane_api.py` uses, for the same reason: this process is
    not on any hot read path where a held pool would matter, and a fresh
    connection means no connection-liveness bookkeeping to get wrong."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def get_existing_sha256(self, kind: str, key: str) -> str | None:
        import asyncpg  # noqa: PLC0415
        conn = await asyncpg.connect(self._dsn)
        try:
            row = await conn.fetchrow(
                "SELECT body_sha256 FROM intake_records WHERE kind = $1 AND key = $2",
                kind, key,
            )
        finally:
            await conn.close()
        return row["body_sha256"] if row is not None else None

    async def upsert(
        self, *, kind: str, key: str, originator_nation: str | None,
        releasable_to: list[str], owning_tier: str, body: Mapping[str, Any],
        body_sha256: str, decision: Mapping[str, Any], decided_at: datetime,
    ) -> None:
        import asyncpg  # noqa: PLC0415
        conn = await asyncpg.connect(self._dsn)
        try:
            await conn.execute(
                """
                INSERT INTO intake_records (
                    kind, key, originator_nation, releasable_to, owning_tier,
                    body, body_sha256, decision, decided_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (kind, key) DO UPDATE SET
                    originator_nation = EXCLUDED.originator_nation,
                    releasable_to = EXCLUDED.releasable_to,
                    owning_tier = EXCLUDED.owning_tier,
                    body = EXCLUDED.body,
                    body_sha256 = EXCLUDED.body_sha256,
                    decision = EXCLUDED.decision,
                    decided_at = EXCLUDED.decided_at
                """,
                kind, key, originator_nation, releasable_to, owning_tier,
                json.dumps(body), body_sha256, json.dumps(decision), decided_at,
            )
        finally:
            await conn.close()


class _AnswersConsumer:
    """Assigns every partition of the answers topic from the earliest
    offset, with no committed group: ADR-0046 v2 §5-6 wants every entry to
    see the whole topic from its own start, independent of any other
    entry's consumption and of this process's own restarts. Modelled on
    `tests/hero_scenario_v3/_cm_helpers.py`'s `consume_topic_recent`, but
    long-lived — this one keeps tailing between polls instead of stopping
    once caught up."""

    def __init__(self, consumer, topic: str) -> None:
        from confluent_kafka import TopicPartition  # noqa: PLC0415
        self._consumer = consumer
        self._topic = topic
        metadata = consumer.list_topics(topic=topic, timeout=10)
        partitions = sorted(metadata.topics[topic].partitions.keys())
        assignments = []
        self._highs: dict[int, int] = {}
        for p in partitions:
            _low, high = consumer.get_watermark_offsets(
                TopicPartition(topic, p), timeout=10, cached=False)
            self._highs[p] = high
            assignments.append(TopicPartition(topic, p, 0))
        consumer.assign(assignments)

    def drain(
        self, answered: AnsweredMap, decl: Declarations, id_pointer: str,
        decode: Callable[[bytes], Any],
    ) -> None:
        from confluent_kafka import TopicPartition  # noqa: PLC0415
        while True:
            msg = self._consumer.poll(0)
            if msg is None:
                break
            if msg.error():
                continue
            try:
                record = decode(msg.value())
            except Exception:  # noqa: BLE001 — an undecodable answer is skipped
                continue
            id_value = pointer.get(record, id_pointer, default=None)
            if isinstance(id_value, str) and id_value:
                answered.put(id_value, extract_label_at(record, decl.label))
        if not self._highs:
            answered.caught_up = True
            return
        positions = self._consumer.position(
            [TopicPartition(self._topic, p) for p in self._highs])
        answered.caught_up = all(
            pos.offset >= self._highs[pos.partition] for pos in positions)


async def _run_entry_forever(
    entry: IntakeEntry, decl: Declarations, answers_decl: Declarations,
    validator: Callable[[Mapping[str, Any]], str | None], *,
    store: IntakeStore, answers_consumer: _AnswersConsumer, answered: AnsweredMap,
) -> None:
    from confluent_kafka import Producer  # noqa: PLC0415
    producer = Producer({"bootstrap.servers": BROKERS})
    produce = _make_produce(producer)
    counters: dict[str, int] = {}
    last_counter_log = asyncio.get_event_loop().time()
    try:
        while _running:
            answers_consumer.drain(answered, answers_decl, entry.answers.id_pointer, _decode)
            await run_poll(
                entry, decl, validator,
                fetch=http_fetch, store=store, answered=answered,
                gate_for=lambda subject: EgressGate.for_destination(subject),
                produce=produce, counters=counters, now=datetime.now(timezone.utc),
            )
            now_monotonic = asyncio.get_event_loop().time()
            if now_monotonic - last_counter_log >= COUNTER_LOG_INTERVAL_S:
                log_counters(entry.name, counters)
                last_counter_log = now_monotonic
            await asyncio.sleep(entry.poll.interval_s)
    finally:
        log_counters(entry.name, counters)
        producer.flush(10)


async def _main_async() -> int:
    from confluent_kafka import Consumer  # noqa: PLC0415

    from kinds import load_declarations, load_kinds  # noqa: PLC0415

    if not CONFIG_PATH:
        log.error("FATAL: OPENDDIL_EGRESS_INTAKE_CONFIG is not set")
        return 2

    known = load_kinds(KINDS_DIR) if KINDS_DIR.is_dir() else {}
    declarations_map = load_declarations(KINDS_DIR) if KINDS_DIR.is_dir() else {}

    try:
        entries = load_intake_config(CONFIG_PATH, declarations_map)
    except Exception as exc:  # noqa: BLE001 — a bad config must not start the runner
        log.error("FATAL: intake config failed to load: %s", exc)
        return 2

    for entry in entries:
        if entry.kind not in known:
            log.error(
                "FATAL: entry %r: kind %r has no schema in %s", entry.name, entry.kind, KINDS_DIR)
            return 2
        if entry.answers.kind not in known:
            log.error(
                "FATAL: entry %r: answers.kind %r has no schema in %s",
                entry.name, entry.answers.kind, KINDS_DIR)
            return 2

    signal_module.signal(signal_module.SIGTERM, _stop)
    signal_module.signal(signal_module.SIGINT, _stop)

    store = IntakeStore(POSTGRES_DSN)

    tasks = []
    for entry in entries:
        decl = declarations_map[entry.kind]
        answers_decl = declarations_map[entry.answers.kind]
        validator = known[entry.kind]
        consumer = Consumer({
            "bootstrap.servers": BROKERS,
            "group.id": f"egress-intake-{entry.name}-{secrets.token_hex(4)}",
            "enable.auto.commit": False,
        })
        answers_consumer = _AnswersConsumer(consumer, entry.answers.topic)
        answered = AnsweredMap()
        tasks.append(asyncio.create_task(_run_entry_forever(
            entry, decl, answers_decl, validator,
            store=store, answers_consumer=answers_consumer, answered=answered,
        )))

    if tasks:
        await asyncio.gather(*tasks)
    return 0


def main() -> int:
    return asyncio.run(_main_async())


if __name__ == "__main__":
    raise SystemExit(main())
