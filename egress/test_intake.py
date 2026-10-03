"""Unit tests for egress/intake.py — ADR-0046 v2 §5, §6.

Run: `python -m pytest egress/test_intake.py -q` from openddil-demo/.

Neutral fixture per the repo's rule (see test_assembler.py's module
docstring): `KindQ` (the artifact) and `KindR` (the record it answers),
with pointers deliberately unlike any real schema — `/ident`, `/audience`,
`/tier`, `/answers_id`, `/endorsed_by`, `/relayed_by` — proof the code
reads the declarations rather than a hard-coded field name.

No HTTP, no broker, no PDP, no Postgres: `fetch`/`store`/`gate_for`/
`produce`/the `AnsweredMap` are all injected, the same seam
`routes.run_once` and `assembler.handle_cm_state_message` give their own
callers.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import delivery  # noqa: E402
from gate import AuthzUnavailable, EgressGate, Label  # noqa: E402
from intake import (  # noqa: E402
    REASON_ANSWERED_RECORD_UNKNOWN,
    REASON_APPROVER_UNENTITLED,
    REASON_APPROVER_UNRESOLVED,
    REASON_APPROVERS_MISSING,
    REASON_LABEL_MISMATCH,
    REASON_ON_BEHALF_OF_UNTRUSTED,
    REASON_SCHEMA_INVALID,
    ADMIT,
    AnsweredMap,
    ApproversSpec,
    AnswersSpec,
    IntakeConfigError,
    IntakeEntry,
    PollSpec,
    decide_artifact,
    load_intake_config,
    run_poll,
)
from kinds import Declarations, validator_for  # noqa: E402

NOW = datetime(2026, 10, 2, tzinfo=timezone.utc)

QUOTE_DECL = Declarations(key="/ident", label="/audience", owning_tier="/tier")
RECORD_DECL = Declarations(key="/ident", label="/audience")

QUOTE_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "ident": {"type": "string"},
        "tier": {"type": "string"},
        "audience": {
            "type": "object",
            "properties": {
                "originator_nation": {"type": ["string", "null"]},
                "releasable_to": {"type": "array", "items": {"type": "string"}},
            },
        },
        "answers_id": {"type": "string"},
        "endorsed_by": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"subject": {"type": "string"}},
            },
        },
        "relayed_by": {"type": "string"},
    },
    "required": ["ident"],
}

VALIDATE_QUOTE = validator_for(QUOTE_SCHEMA)


def make_entry(*, on_behalf_of_pointer=None) -> IntakeEntry:
    return IntakeEntry(
        name="quotes",
        source_destination="system:relay-a",
        kind="KindQ",
        poll=PollSpec(url="http://stand-in/artifacts", interval_s=5.0, items_pointer="/items"),
        answers=AnswersSpec(
            topic="answers-topic", kind="KindR",
            ref_pointer="/answers_id", id_pointer="/ident",
        ),
        approvers=ApproversSpec(array_pointer="/endorsed_by", subject_field="subject"),
        onward_topic="release-requests",
        on_behalf_of_pointer=on_behalf_of_pointer,
    )


def artifact(**overrides) -> dict:
    base = {
        "ident": "art-1",
        "tier": "edge-07",
        "audience": {"originator_nation": "ATL", "releasable_to": ["ATL", "BRV"]},
        "answers_id": "rec-1",
        "endorsed_by": [{"subject": "system:approver-a"}],
    }
    base.update(overrides)
    return base


def answered_map_with(id_value: str, *, originator_nation="ATL",
                       releasable_to=("ATL", "BRV"), caught_up=True) -> AnsweredMap:
    answered = AnsweredMap()
    answered.put(id_value, Label(originator_nation=originator_nation,
                                  releasable_to=tuple(releasable_to)))
    answered.caught_up = caught_up
    return answered


def resolved_gate(nations=("ATL", "BRV"), *, trust_on_behalf_of=False) -> EgressGate:
    return EgressGate("system:approver-a", nations, destination_known=True,
                       trust_on_behalf_of=trust_on_behalf_of)


def unresolved_gate() -> EgressGate:
    return EgressGate("system:unknown", [], destination_known=False)


def unentitled_gate() -> EgressGate:
    return EgressGate("system:approver-a", ["ZZZ"], destination_known=True)


# --- decide_artifact: admit ---------------------------------------------

def test_decide_admits():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.allowed is True
    assert outcome.decision.reason == ADMIT
    assert outcome.decision.approvers == ("system:approver-a",)
    assert outcome.owning_tier == "edge-07"


def test_decide_admits_with_entitled_on_behalf_of():
    entry = make_entry(on_behalf_of_pointer="/relayed_by")
    answered = answered_map_with("rec-1")
    gates = {
        "system:approver-a": resolved_gate(),
        "system:relay-a": resolved_gate(trust_on_behalf_of=True),
        "system:relay-subject": resolved_gate(),
    }
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        artifact(relayed_by="system:relay-subject"),
        existing_sha256=None, answered=answered, gate_for=gates.__getitem__,
    )
    assert outcome.decision.allowed is True
    assert outcome.decision.on_behalf_of == "system:relay-subject"


# --- schema_invalid -------------------------------------------------------

def test_decide_schema_invalid():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    bad = artifact()
    del bad["ident"]
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, bad,
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_SCHEMA_INVALID


# --- label_mismatch --------------------------------------------------------

def test_decide_label_mismatch():
    entry = make_entry()
    answered = answered_map_with("rec-1", releasable_to=("CRN",))
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_LABEL_MISMATCH


def test_decide_label_mismatch_lists_approver_subjects_as_found_unresolved():
    """label_mismatch is decided before any approver is resolved or
    entitlement-checked, but the artifact's declared approver subjects are
    still named on the line — found, not resolved."""
    entry = make_entry()
    answered = answered_map_with("rec-1", releasable_to=("CRN",))
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        artifact(endorsed_by=[{"subject": "system:approver-a"},
                               {"subject": "system:approver-b"}]),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.reason == REASON_LABEL_MISMATCH
    assert outcome.decision.approvers == ("system:approver-a", "system:approver-b")


# --- answered_record_unknown vs deferred -----------------------------------

def test_decide_defers_when_not_caught_up():
    entry = make_entry()
    answered = AnsweredMap()
    answered.caught_up = False
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.status == "deferred"
    assert outcome.decision is None


def test_decide_refuses_answered_record_unknown_once_caught_up():
    entry = make_entry()
    answered = AnsweredMap()
    answered.caught_up = True
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_ANSWERED_RECORD_UNKNOWN


# --- approvers --------------------------------------------------------------

def test_decide_approver_unresolved():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: unresolved_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_APPROVER_UNRESOLVED


def test_decide_approver_unentitled():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: unentitled_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_APPROVER_UNENTITLED


def test_decide_approvers_missing():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(endorsed_by=[]),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_APPROVERS_MISSING


# --- registry versions: startup vs. decision ---------------------------------

STARTUP_VERSIONS = {"policy_version": "startup-pv", "corpus_version": "startup-cv"}


def test_schema_invalid_cites_startup_versions():
    """A pre-PDP refusal (no gate is ever asked for schema_invalid) cites the
    startup-loaded versions, never 'unknown', and says so with
    versions_from=startup."""
    entry = make_entry()
    answered = answered_map_with("rec-1")
    bad = artifact()
    del bad["ident"]
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, bad,
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        startup_versions=STARTUP_VERSIONS,
    )
    assert outcome.decision.reason == REASON_SCHEMA_INVALID
    assert outcome.decision.policy_version == "startup-pv"
    assert outcome.decision.corpus_version == "startup-cv"
    assert outcome.decision.versions_from == "startup"


def test_answered_record_unknown_cites_startup_versions():
    entry = make_entry()
    answered = AnsweredMap()
    answered.caught_up = True
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        startup_versions=STARTUP_VERSIONS,
    )
    assert outcome.decision.reason == REASON_ANSWERED_RECORD_UNKNOWN
    assert outcome.decision.versions_from == "startup"
    assert outcome.decision.policy_version == "startup-pv"


def test_label_mismatch_cites_startup_versions():
    entry = make_entry()
    answered = answered_map_with("rec-1", releasable_to=("CRN",))
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        startup_versions=STARTUP_VERSIONS,
    )
    assert outcome.decision.reason == REASON_LABEL_MISMATCH
    assert outcome.decision.versions_from == "startup"


def test_approvers_missing_cites_startup_versions():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(endorsed_by=[]),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        startup_versions=STARTUP_VERSIONS,
    )
    assert outcome.decision.reason == REASON_APPROVERS_MISSING
    assert outcome.decision.versions_from == "startup"


def test_without_startup_versions_pre_pdp_refusal_still_says_unknown_by_default():
    """Every existing caller that does not pass `startup_versions` keeps
    today's literal default — this parameter is additive."""
    entry = make_entry()
    answered = answered_map_with("rec-1")
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(endorsed_by=[]),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.decision.policy_version == "unknown"
    assert outcome.decision.versions_from == "startup"


def test_pdp_answered_decision_cites_its_own_versions_not_startup():
    """Once a gate is actually asked (admit, or any reason reached only
    after `gate_for` is called), the decision cites THAT gate's own
    versions and says versions_from=decision — even when startup versions
    were also loaded."""
    entry = make_entry()
    answered = answered_map_with("rec-1")
    gate = EgressGate(
        "system:approver-a", ("ATL", "BRV"), destination_known=True,
        policy_version="gate-pv", corpus_version="gate-cv",
    )
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, artifact(),
        existing_sha256=None, answered=answered,
        gate_for=lambda subject: gate,
        startup_versions=STARTUP_VERSIONS,
    )
    assert outcome.decision.allowed is True
    assert outcome.decision.policy_version == "gate-pv"
    assert outcome.decision.corpus_version == "gate-cv"
    assert outcome.decision.versions_from == "decision"


# --- on_behalf_of_untrusted --------------------------------------------------

def test_decide_on_behalf_of_untrusted():
    entry = make_entry(on_behalf_of_pointer="/relayed_by")
    answered = answered_map_with("rec-1")
    gates = {
        "system:approver-a": resolved_gate(),
        "system:relay-a": resolved_gate(trust_on_behalf_of=False),
    }
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        artifact(relayed_by="system:relay-subject"),
        existing_sha256=None, answered=answered, gate_for=gates.__getitem__,
    )
    assert outcome.decision.allowed is False
    assert outcome.decision.reason == REASON_ON_BEHALF_OF_UNTRUSTED


@pytest.mark.parametrize("subject_gate", [unresolved_gate, unentitled_gate],
                         ids=["unresolved", "unentitled"])
def test_decide_on_behalf_of_subject_is_checked_like_an_approver(subject_gate):
    """A trusted source does not vouch for the subject it relays: that
    subject is resolved and entitlement-checked exactly as an approver is."""
    entry = make_entry(on_behalf_of_pointer="/relayed_by")
    answered = answered_map_with("rec-1")
    gates = {
        "system:approver-a": resolved_gate(),
        "system:relay-a": resolved_gate(trust_on_behalf_of=True),
        "system:relay-subject": subject_gate(),
    }
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        artifact(relayed_by="system:relay-subject"),
        existing_sha256=None, answered=answered, gate_for=gates.__getitem__,
    )
    assert outcome.decision.allowed is False
    expected = (REASON_APPROVER_UNRESOLVED if subject_gate is unresolved_gate
                else REASON_APPROVER_UNENTITLED)
    assert outcome.decision.reason == expected
    assert outcome.decision.on_behalf_of == "system:relay-subject"


# --- dedup by body hash ------------------------------------------------------

def test_decide_skips_unchanged_body():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    one = artifact()
    from intake import canonical_sha256
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, one,
        existing_sha256=canonical_sha256(one), answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.status == "skipped_unchanged"
    assert outcome.decision is None


def test_decide_redecides_changed_body_as_a_revision():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    original = artifact()
    changed = artifact(tier="edge-09")
    from intake import canonical_sha256
    outcome = decide_artifact(
        entry, QUOTE_DECL, VALIDATE_QUOTE, changed,
        existing_sha256=canonical_sha256(original), answered=answered,
        gate_for=lambda subject: resolved_gate(),
    )
    assert outcome.status == "decided"
    assert outcome.decision.allowed is True
    assert outcome.owning_tier == "edge-09"


# --- run_poll: delivery failure, authz outage, HTTP failure -----------------

class _FakeStore:
    def __init__(self, existing: dict | None = None):
        self.existing = dict(existing or {})
        self.upserts: list[dict] = []

    async def get_existing_sha256(self, kind, key):
        return self.existing.get((kind, key))

    async def upsert(self, **kwargs):
        self.upserts.append(kwargs)
        self.existing[(kwargs["kind"], kwargs["key"])] = kwargs["body_sha256"]


def _fetch_one(art: Mapping[str, Any]):
    def fetch(url):
        return {"items": [art]}
    return fetch


def test_run_poll_delivery_failure_stores_nothing_then_retry_produces():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    store = _FakeStore()
    produced: list[tuple] = []
    state = {"fail": True}

    def flaky_produce(topic, value, key):
        if state["fail"]:
            raise delivery.DeliveryFailed(topic, key, "broker refused")
        produced.append((topic, value, key))

    counters: dict[str, int] = {}
    asyncio.run(run_poll(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        fetch=_fetch_one(artifact()), store=store, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        produce=flaky_produce, counters=counters, now=NOW,
    ))
    assert store.upserts == []
    assert counters["delivery_failed"] == 1

    state["fail"] = False
    asyncio.run(run_poll(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        fetch=_fetch_one(artifact()), store=store, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        produce=flaky_produce, counters=counters, now=NOW,
    ))
    assert len(produced) == 1
    assert len(store.upserts) == 1
    assert store.upserts[0]["decision"]["allowed"] is True


def test_run_poll_authz_outage_stores_nothing():
    entry = make_entry()
    answered = answered_map_with("rec-1")
    store = _FakeStore()
    counters: dict[str, int] = {}

    def outage(subject):
        raise AuthzUnavailable("topaz unreachable")

    asyncio.run(run_poll(
        entry, QUOTE_DECL, VALIDATE_QUOTE,
        fetch=_fetch_one(artifact()), store=store, answered=answered,
        gate_for=outage, produce=lambda *a: None, counters=counters, now=NOW,
    ))
    assert store.upserts == []
    assert counters["authz_unavailable"] == 1


def test_run_poll_http_failure_is_a_warning_not_fatal(caplog):
    entry = make_entry()
    answered = answered_map_with("rec-1")
    store = _FakeStore()
    counters: dict[str, int] = {}

    def failing_fetch(url):
        raise RuntimeError("HTTP 500")

    with caplog.at_level("WARNING"):
        asyncio.run(run_poll(
            entry, QUOTE_DECL, VALIDATE_QUOTE,
            fetch=failing_fetch, store=store, answered=answered,
            gate_for=lambda subject: resolved_gate(),
            produce=lambda *a: None, counters=counters, now=NOW,
        ))
    assert store.upserts == []
    assert "polled" not in counters
    assert any("intake poll failed" in rec.message for rec in caplog.records)


# --- config errors are fatal -------------------------------------------------

def test_load_intake_config_unknown_kind_raises(tmp_path):
    config_path = tmp_path / "intake.json"
    config_path.write_text(
        '[{"name": "n1", "source_destination": "system:relay-a", "kind": "NoSuchKind",'
        ' "poll": {"url": "http://x", "interval_s": 5, "items_pointer": ""},'
        ' "answers": {"topic": "t", "kind": "KindR", "ref_pointer": "/a", "id_pointer": "/b"},'
        ' "approvers": {"array_pointer": "/e", "subject_field": "subject"},'
        ' "onward_topic": "o"}]',
        encoding="utf-8",
    )
    with pytest.raises(IntakeConfigError):
        load_intake_config(config_path, {"KindQ": QUOTE_DECL, "KindR": RECORD_DECL})


def test_load_intake_config_missing_poll_url_raises(tmp_path):
    config_path = tmp_path / "intake.json"
    config_path.write_text(
        '[{"name": "n1", "source_destination": "system:relay-a", "kind": "KindQ",'
        ' "poll": {"url": "", "interval_s": 5, "items_pointer": ""},'
        ' "answers": {"topic": "t", "kind": "KindR", "ref_pointer": "/a", "id_pointer": "/b"},'
        ' "approvers": {"array_pointer": "/e", "subject_field": "subject"},'
        ' "onward_topic": "o"}]',
        encoding="utf-8",
    )
    with pytest.raises(IntakeConfigError):
        load_intake_config(config_path, {"KindQ": QUOTE_DECL, "KindR": RECORD_DECL})


def test_load_intake_config_valid_entry_loads(tmp_path):
    config_path = tmp_path / "intake.json"
    config_path.write_text(
        '[{"name": "n1", "source_destination": "system:relay-a", "kind": "KindQ",'
        ' "poll": {"url": "http://x", "interval_s": 5, "items_pointer": ""},'
        ' "answers": {"topic": "t", "kind": "KindR", "ref_pointer": "/a", "id_pointer": "/b"},'
        ' "approvers": {"array_pointer": "/e", "subject_field": "subject"},'
        ' "onward_topic": "o"}]',
        encoding="utf-8",
    )
    entries = load_intake_config(config_path, {"KindQ": QUOTE_DECL, "KindR": RECORD_DECL})
    assert len(entries) == 1
    assert entries[0].name == "n1"
    assert entries[0].on_behalf_of_pointer is None
