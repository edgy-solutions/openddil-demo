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
    REASON_NO_OVERLAP,
    REASON_UNLABELLED,
    EgressGate,
    Label,
    classify,
    compile_predicate,
    extract_label,
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
