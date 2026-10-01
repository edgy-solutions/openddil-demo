"""Unit tests for the Contract A -> CoT event builder.

Run: `py -3 -m pytest egress/test_cot_adapter.py -q` from openddil-demo/.

No Kafka, no TCP, no TAK server. Every test here is about what `build_event`
puts on the wire for a given (record, label) pair — the same shape of test as
test_gate.py, which checks the DECISION without a running PDP. The connector
to an actual TAK server is checked in
tests/hero_scenario_v3/test_51_egress_cot_counts.py.
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from cot_adapter import build_event  # noqa: E402
from gate import Label, extract_label  # noqa: E402


def rec(originator=None, releasable=None, status=None):
    body: dict = {}
    labels: dict = {}
    if originator is not None:
        labels["originator_nation"] = originator
    if releasable is not None:
        labels["releasable_to"] = releasable
    if labels:
        body["provenance"] = labels
    if status is not None:
        body["status"] = status
    return body


# --- the fence ---------------------------------------------------------------

def test_unlabelled_record_produces_no_event():
    record = rec()
    label = extract_label(record)
    assert not label.is_labelled
    assert build_event(record, "dis:1:1:1000", label) is None


def test_classified_shaped_record_is_not_this_module_s_concern():
    """The gate already refused anything carrying a classification before it
    reached the sink topic this adapter consumes — extract_label does not
    even look at classification, so a labelled record is built regardless.
    This test exists so a future change to extract_label's signature is
    noticed here too, not just in test_gate.py."""
    record = rec("ATL", ["BDR"])
    label = extract_label(record)
    assert build_event(record, "dis:1:1:1000", label) is not None


# --- labels carried exactly ---------------------------------------------------

def test_originator_nation_is_carried_exactly():
    record = rec("ATL", ["BDR"])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    release = event.find("detail/openddil_release")
    assert release.get("originator_nation") == "ATL"


def test_releasable_to_entries_are_carried_in_record_order():
    record = rec("ATL", ["BDR", "CCC", "AAA"])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    release = event.find("detail/openddil_release")
    children = release.findall("releasable_to")
    assert [c.get("nation") for c in children] == ["BDR", "CCC", "AAA"]


def test_empty_releasable_to_is_an_element_with_zero_children():
    """ADR-0029: released to nobody beyond the originator is a different fact
    from "no label" — it is carried as a present element with no children,
    never omitted."""
    record = rec("ATL", [])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    release = event.find("detail/openddil_release")
    assert release is not None
    assert release.findall("releasable_to") == []


def test_aggregate_with_audience_and_no_author_still_builds_an_event():
    record = rec(None, ["ATL", "BDR"])
    label = extract_label(record)
    assert label.is_labelled
    event = build_event(record, "dis:9:1:1000", label)
    release = event.find("detail/openddil_release")
    assert release.get("originator_nation") == ""
    assert [c.get("nation") for c in release.findall("releasable_to")] == ["ATL", "BDR"]


def test_status_fields_are_carried_onto_openddil_status():
    record = rec("ATL", ["BDR"], status={
        "platform_variant": "MRAD-X",
        "overall_severity": "DEGRADED",
        "computed_at": "2026-10-01T00:00:00.000Z",
        "status_revision": 42,
    })
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    status = event.find("detail/openddil_status")
    assert status.get("asset_id") == "dis:1:1:1000"
    assert status.get("platform_variant") == "MRAD-X"
    assert status.get("overall_severity") == "DEGRADED"
    assert status.get("computed_at") == "2026-10-01T00:00:00.000Z"
    assert status.get("status_revision") == "42"


def test_missing_status_block_does_not_raise():
    record = rec("ATL", ["BDR"])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    status = event.find("detail/openddil_status")
    assert status.get("status_revision") == "0"


def test_key_is_preferred_over_status_asset_id_for_uid_but_status_asset_id_fills_contact():
    record = rec("ATL", [], status={"asset_id": "should-not-win"})
    label = extract_label(record)
    event = build_event(record, "key-wins", label)
    assert event.get("uid") == "key-wins"
    assert event.find("detail/contact").get("callsign") == "key-wins"


def test_no_key_falls_back_to_status_asset_id():
    record = rec("ATL", [], status={"asset_id": "dis:1:1:2000"})
    label = extract_label(record)
    event = build_event(record, None, label)
    assert event.get("uid") == "dis:1:1:2000"


# --- the XML shape itself -----------------------------------------------------

def test_event_round_trips_through_parse():
    record = rec("ATL", ["BDR"], status={"status_revision": 1})
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    data = ET.tostring(event, encoding="utf-8")
    parsed = ET.fromstring(data)
    assert parsed.tag == "event"
    assert parsed.get("uid") == "dis:1:1:1000"


def test_event_attributes_match_the_spec_shape():
    record = rec("ATL", ["BDR"])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    assert event.get("version") == "2.0"
    assert event.get("type") == "a-u-G"
    assert event.get("how") == "m-f"
    for key in ("time", "start", "stale"):
        assert event.get(key).endswith("Z")


def test_point_is_the_unknown_position_convention():
    record = rec("ATL", ["BDR"])
    label = extract_label(record)
    event = build_event(record, "dis:1:1:1000", label)
    point = event.find("point")
    assert point.get("lat") == "0.0"
    assert point.get("lon") == "0.0"
    assert point.get("hae") == "9999999.0"
    assert point.get("ce") == "9999999.0"
    assert point.get("le") == "9999999.0"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
