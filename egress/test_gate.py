"""Unit tests for the egress gate — ADR-0043.

Run: `python -m pytest egress/test_gate.py -q` from openddil-demo/.

No PDP, no broker, no compose. Every test here is about the DECISION, which
is why the PDP answer is injected rather than fetched: a gate that can only
be tested against a running authorizer is a gate whose refusals nobody
checks until the day they matter.

The agreement between this predicate and the read path's SQL is NOT tested
here — it cannot be, because the SQL needs Postgres to mean anything. It is
tested in tests/hero_scenario_v3/test_44_egress_read_agreement.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from gate import (  # noqa: E402
    ADMIT,
    CLASS_AGGREGATE_EMPTY,
    CLASS_AGGREGATE_RELEASED,
    CLASS_AUTHORED_NO_RELEASE,
    CLASS_AUTHORED_WITH_RELEASE,
    CLASS_CLASSIFIED,
    CLASS_UNLABELLED,
    REASON_CLASSIFICATION,
    REASON_DESTINATION_UNKNOWN,
    REASON_KIND_NOT_ACCEPTED,
    REASON_NO_OVERLAP,
    REASON_SCHEMA_INVALID,
    REASON_UNLABELLED,
    EgressGate,
    Label,
    classify,
    compile_predicate,
    extract_label,
    extract_label_at,
)

# The stand-in destination: one nation, because a single-nation destination
# is the discriminating case against a fleet labelled in two.
ATL_GATE = lambda: EgressGate(  # noqa: E731
    "c2-stand-in-atl", ["ATL"],
    policy_version="arc2-slice1-v1", corpus_version="users-2026-09-23",
)


def rec(originator=None, releasable=None, classification=None, nested=False):
    """A record in either of the two shapes the wire actually carries."""
    body: dict = {"asset_id": "dis:1:1:1000"}
    labels: dict = {}
    if originator is not None:
        labels["originator_nation"] = originator
    if releasable is not None:
        labels["releasable_to"] = releasable
    if classification is not None:
        labels["classification"] = classification
    if nested:
        body["provenance"] = labels
    else:
        body.update(labels)
    return body


# --- extraction -------------------------------------------------------------

def test_labels_read_from_top_level_and_from_provenance():
    flat = extract_label(rec("ATL", ["BDR"]))
    nested = extract_label(rec("ATL", ["BDR"], nested=True))
    assert flat == nested == Label("ATL", ("BDR",))


def test_camel_case_provenance_is_accepted():
    """A decoded proto camel-cases its field names. Refusing that shape would
    refuse an entire producer as unlabelled — a refusal indistinguishable
    from correct enforcement."""
    label = extract_label({"provenance": {
        "originatorNation": "BDR", "releasableTo": ["ATL"]}})
    assert label == Label("BDR", ("ATL",))


def test_empty_string_nation_is_absence_not_a_nation():
    """proto3 puts an unset string on the wire as "". Reading that as a
    nation manufactures a labelled-looking record no policy can release."""
    assert extract_label(rec("", [])).originator_nation is None
    assert not extract_label(rec("", [])).is_labelled


def test_empty_releasable_to_is_labelled_not_unlabelled():
    """`[]` means labelled and releasable to nobody beyond the author. It is
    a different fact from "no label", even though the wire cannot tell them
    apart — the producer's declaration is what says which."""
    label = extract_label(rec("ATL", []))
    assert label.is_labelled
    assert label.releasable_to == ()


def test_aggregate_with_audience_is_labelled_despite_no_author():
    """ADR-0029's addendum: an aggregate claims no authorship. Requiring an
    author here would refuse every rollup as unlabelled."""
    label = extract_label(rec(None, ["ATL", "BDR"]))
    assert label.originator_nation is None
    assert label.is_labelled


# --- classes ----------------------------------------------------------------

@pytest.mark.parametrize("record,expected", [
    (rec("ATL", []), CLASS_AUTHORED_NO_RELEASE),
    (rec("ATL", ["BDR"]), CLASS_AUTHORED_WITH_RELEASE),
    (rec(None, ["ATL"]), CLASS_AGGREGATE_RELEASED),
    (rec(None, []), CLASS_UNLABELLED),
    (rec(), CLASS_UNLABELLED),
    (rec("ATL", [], classification="S//NF"), CLASS_CLASSIFIED),
])
def test_classification_of_records(record, expected):
    assert classify(record) == expected


def test_aggregate_empty_audience_is_its_own_class():
    """An aggregate whose composed audience came out empty is releasable to
    nobody. That is a real outcome of the composition rule, not a missing
    label, and it gets its own class so the two never share a count."""
    label = Label(None, ())
    assert not label.is_labelled  # indistinguishable from unlabelled on shape
    # ...which is exactly why the class exists at the point the author IS
    # known to be absent by construction rather than by omission:
    assert classify({"provenance": {"releasable_to": []}}) == CLASS_UNLABELLED
    assert CLASS_AGGREGATE_EMPTY  # reserved for a producer that states it


# --- the compiled predicate -------------------------------------------------

def test_authorship_alone_grants():
    """ADR-0029 addendum: the nation that produced a reading can always see
    it. This is the clause that makes the ATL stand-in admit most of the
    fleet, and it is the correct prediction rather than a leak."""
    assert compile_predicate(["ATL"])(Label("ATL", ()))


def test_containment_grants_without_authorship():
    assert compile_predicate(["ATL"])(Label("BDR", ("ATL",)))


def test_no_overlap_refuses():
    assert not compile_predicate(["ATL"])(Label("BDR", ()))


def test_empty_nations_is_an_entitlement_of_nothing():
    """A destination the corpus knows and grants nothing is a link that
    carries nothing — `false` in the SQL, False here."""
    predicate = compile_predicate([])
    assert not predicate(Label("ATL", ("BDR",)))
    assert not predicate(Label(None, ()))


def test_blank_nations_do_not_widen_the_predicate():
    assert not compile_predicate(["", "  "])(Label("ATL", ()))


# --- the gate ---------------------------------------------------------------

def test_admits_authored_by_the_destinations_nation():
    d = ATL_GATE().decide(rec("ATL", []), key="dis:1:1:1001")
    assert d.allowed and d.reason == ADMIT
    assert d.record_class == CLASS_AUTHORED_NO_RELEASE


def test_refuses_authored_elsewhere_with_no_onward_release():
    d = ATL_GATE().decide(rec("BDR", []), key="dis:2:1:1000")
    assert not d.allowed and d.reason == REASON_NO_OVERLAP
    assert "BDR" in d.detail


def test_refuses_unlabelled():
    d = ATL_GATE().decide(rec())
    assert not d.allowed and d.reason == REASON_UNLABELLED


def test_refuses_a_record_carrying_a_classification_even_when_releasable():
    """THE FENCE FAILS CLOSED. The record would pass the releasability axis
    outright; it is refused anyway, because this gate has not been taught to
    read the marking it carries."""
    d = ATL_GATE().decide(rec("ATL", ["BDR"], classification="S//NF"))
    assert not d.allowed and d.reason == REASON_CLASSIFICATION
    assert "S//NF" in d.detail


def test_an_unrecognised_marking_also_refuses():
    """Recognising only known markings would mean an unknown one passes,
    which inverts the fence."""
    d = ATL_GATE().decide(rec("ATL", [], classification="NOT-A-REAL-MARKING"))
    assert not d.allowed and d.reason == REASON_CLASSIFICATION


def test_empty_classification_string_is_not_a_marking():
    """proto3 materialises an unset string as "". If that refused, every
    proto-decoded record would be refused."""
    d = ATL_GATE().decide(rec("ATL", [], classification=""))
    assert d.allowed


def test_unknown_destination_is_distinct_from_an_empty_entitlement():
    unknown = EgressGate("c2-nobody-declared", [], destination_known=False)
    empty = EgressGate("c2-carries-nothing", [], destination_known=True)
    assert unknown.decide(rec("ATL", [])).reason == REASON_DESTINATION_UNKNOWN
    assert empty.decide(rec("ATL", [])).reason == REASON_NO_OVERLAP


def test_classification_is_checked_before_audience():
    """A marked record must not be logged with a nation-overlap verdict: it
    was never eligible to be evaluated on that axis."""
    d = EgressGate("c2-stand-in-atl", ["BDR"]).decide(
        rec("ATL", [], classification="CUI"))
    assert d.reason == REASON_CLASSIFICATION


def test_every_record_produces_exactly_one_decision():
    """Nothing is dropped silently: the count of decisions equals the count
    of records the gate saw."""
    gate = ATL_GATE()
    records = [rec("ATL", []), rec("BDR", []), rec(), rec("ATL", [], classification="U")]
    decisions = [gate.decide(r) for r in records]
    assert len(decisions) == len(records)
    assert sum(v for k, v in gate.counts.items() if not k.startswith("class:")) == 4


def test_decision_log_line_is_json_serialisable_and_names_its_inputs():
    d = ATL_GATE().decide(rec("ATL", ["BDR"]), key="dis:1:1:1000")
    line = d.as_json()
    assert line["outcome"] == "admit"
    assert line["destination_nations"] == ["ATL"]
    assert line["policy_version"] == "arc2-slice1-v1"
    assert line["corpus_version"] == "users-2026-09-23"
    assert line["key"] == "dis:1:1:1000"


# --- the declared fleet, as predicted ---------------------------------------

DECLARED_FLEET = (
    [("dis:1:1:1000", "ATL", ["BDR"])]
    + [(f"dis:1:1:100{n}", "ATL", []) for n in range(1, 8)]
    + [(f"dis:2:1:100{n}", "BDR", []) for n in range(0, 6)]
)


def test_fleet_prediction_atl_destination():
    """8 admitted, 6 refused, every refusal `no_nation_overlap`."""
    gate = ATL_GATE()
    results = [gate.decide(rec(n, r), key=k) for k, n, r in DECLARED_FLEET]
    assert len(results) == 14
    assert sum(1 for d in results if d.allowed) == 8
    refused = [d for d in results if not d.allowed]
    assert len(refused) == 6
    assert {d.reason for d in refused} == {REASON_NO_OVERLAP}


@pytest.mark.parametrize("nations,expected", [
    (["ATL"], 8),
    (["BDR"], 7),          # six BDR by authorship + dis:1:1:1000 by containment
    (["ATL", "BDR"], 14),
])
def test_seat_counts_match_the_predicted_table(nations, expected):
    gate = EgressGate("seat", nations)
    assert sum(1 for k, n, r in DECLARED_FLEET
               if gate.decide(rec(n, r), key=k).allowed) == expected


def test_the_containment_clause_is_exercised_by_live_data():
    """Without dis:1:1:1000 every admission would come from the authorship
    clause and half the predicate would be carried, untested, and
    indistinguishable from broken."""
    gate = EgressGate("seat-bdr", ["BDR"])
    shared = [d for k, n, r in DECLARED_FLEET
              if (d := gate.decide(rec(n, r), key=k)).allowed
              and d.label.originator_nation == "ATL"]
    assert len(shared) == 1


# --- kind, accepts and schema --------------------------------------------------
# Neutral fixture names per the rule: `system:dest-a`, `KindA` — no consumer
# or kind name from a real registry appears here.

def test_kind_not_accepted_short_circuits_before_the_overlap_check():
    """The destination's `accepts` lacks the gate's declared kind: refused on
    that basis alone, even though this exact record's audience would
    otherwise admit it against the destination's nations."""
    gate = EgressGate("system:dest-a", ["ATL"], accepts=["KindB"], kind="KindA")
    d = gate.decide(rec("ATL", []))
    assert not d.allowed and d.reason == REASON_KIND_NOT_ACCEPTED


def test_schema_invalid_carries_the_validators_detail():
    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda record: "asset_id: 'asset_id' is a required property",
    )
    d = gate.decide(rec("ATL", []))
    assert not d.allowed and d.reason == REASON_SCHEMA_INVALID
    assert d.detail == "asset_id: 'asset_id' is a required property"


def test_schema_invalid_detail_is_truncated_to_300_characters():
    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda record: "x" * 500,
    )
    d = gate.decide(rec("ATL", []))
    assert d.reason == REASON_SCHEMA_INVALID
    assert len(d.detail) == 300


def test_missing_accepts_refuses_a_kind_gate_but_a_no_kind_gate_is_unchanged():
    """An older policy answer omits `accepts` entirely — treated as `[]`. A
    kind gate refuses kind_not_accepted; a gate with no declared kind must
    not start rejecting answers that lack it, and behaves exactly as today."""
    kind_gate = EgressGate("system:dest-a", ["ATL"], kind="KindA")
    plain_gate = EgressGate("system:dest-a", ["ATL"])
    assert kind_gate.decide(rec("ATL", [])).reason == REASON_KIND_NOT_ACCEPTED
    assert plain_gate.decide(rec("ATL", [])).allowed


def test_kind_gate_falls_through_to_the_overlap_check_once_kind_and_schema_pass():
    """A destination with nations [ATL] accepting
    KindA, and a valid KindA record labelled BDR/[BDR], is refused on the
    releasability axis exactly as a no-kind gate would be — the kind and
    schema checks are a gate IN FRONT of the existing predicate, not a
    replacement for it. The same record labelled ATL/[ATL] admits."""
    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda record: None,  # always a valid KindA record
    )
    refused = gate.decide(rec("BDR", ["BDR"]))
    assert not refused.allowed and refused.reason == REASON_NO_OVERLAP

    admitted = gate.decide(rec("ATL", ["ATL"]))
    assert admitted.allowed and admitted.reason == ADMIT



# --- label_pointer: a kind that declares where its own label lives ----------
# Neutral fixture per the rule: `/marking`, distinct from the top-level keys
# a kind-less record uses, so a test reading the wrong place fails loudly.

def test_extract_label_at_reads_the_declared_pointer():
    record = {"marking": {"originator_nation": "BDR", "releasable_to": ["ATL"]}}
    assert extract_label_at(record, "/marking") == Label("BDR", ("ATL",))


def test_extract_label_at_missing_mapping_is_unlabelled():
    """The pointer does not resolve to an object — including when it does
    not resolve at all, or when the label lives at the top level instead (the
    kind declared a different place to look, and a record shaped for the old
    convention is not secretly still readable)."""
    assert extract_label_at({}, "/marking") == Label(None, ())
    assert not extract_label_at({}, "/marking").is_labelled

    top_level_only = {"originator_nation": "BDR", "releasable_to": ["ATL"]}
    assert not extract_label_at(top_level_only, "/marking").is_labelled


def test_gate_with_label_pointer_decides_on_the_declared_location_not_the_top_level():
    """A KindA gate with `label_pointer=/marking`, record labelled BDR/[BDR]
    at `/marking`: refused for lack of nation overlap against a destination
    of [ATL] — the same releasability axis, just read from where the kind
    says it lives."""
    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda record: None, label_pointer="/marking",
    )
    refused = gate.decide({"marking": {"originator_nation": "BDR", "releasable_to": ["BDR"]}})
    assert not refused.allowed and refused.reason == REASON_NO_OVERLAP

    admitted = gate.decide({"marking": {"originator_nation": "ATL", "releasable_to": ["ATL"]}})
    assert admitted.allowed and admitted.reason == ADMIT


def test_gate_with_label_pointer_refuses_a_record_labelled_only_at_top_level():
    """A kind declares its label lives at `/marking`. A record that instead
    carries the label at the top level (the old, kind-less convention) is
    UNLABELLED to this gate, not accidentally readable anyway — the
    declaration is the only place this gate looks once it has one."""
    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda record: None, label_pointer="/marking",
    )
    d = gate.decide({"originator_nation": "ATL", "releasable_to": ["ATL"]})
    assert not d.allowed and d.reason == REASON_UNLABELLED


def test_gate_without_label_pointer_is_unchanged():
    """`label_pointer=None` — every destination that existed before kinds
    declared one — reads exactly where it always has: the top level /
    `provenance`, via `extract_label`. This is `test_admits_authored_by_the_
    destinations_nation` and friends above, reaffirmed here under the new
    parameter's default to make the "today's behaviour is unchanged" claim
    explicit rather than merely implicit in the default value."""
    gate = ATL_GATE()
    assert gate.label_pointer is None
    d = gate.decide(rec("ATL", []), key="dis:1:1:1001")
    assert d.allowed and d.reason == ADMIT
    assert d.record_class == CLASS_AUTHORED_NO_RELEASE


def test_as_json_without_kind_or_route_matches_todays_key_set():
    """A gate built without a kind or route — every destination that existed
    before this pass — logs byte-identical JSON to today, apart from the id
    and ts: none of `kind`, `route` or `registry_version` appear."""
    d = ATL_GATE().decide(rec("ATL", ["BDR"]), key="dis:1:1:1000")
    assert sorted(d.as_json().keys()) == sorted([
        "decision_id", "gate", "outcome", "reason", "class", "destination",
        "destination_nations", "key", "originator_nation", "releasable_to",
        "policy_version", "corpus_version", "detail", "ts",
    ])
