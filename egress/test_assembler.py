"""Unit tests for egress/assembler.py — ADR-0043, the assembler pass.

Run: `python -m pytest egress/test_assembler.py -q` from openddil-demo/.

Neutral fixture per the rule: `KindA`, with pointers deliberately unlike any
real schema (`/ref`, `/marking`, `/tier`, `/subject`, `/what/part`,
`/what/code`, `/what/seen_at`, `/reports`, `/context`) — proof the code reads
the declarations rather than a hard-coded field name.

No broker, no PDP, no postgres: `read_asset` and `produce` are injected, the
same seam `routes.run_once` gives `main.py`.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from assembler import (  # noqa: E402
    AssemblerConfigError,
    AssemblerRoute,
    _RouteState,
    assemble,
    episodes,
    handle_cm_state_message,
    load_assembler_config,
    record_key,
)
from gate import ADMIT, REASON_NO_OVERLAP, REASON_UNLABELLED, EgressGate  # noqa: E402
from kinds import Declarations, EpisodeDecl, load_declarations, load_kinds  # noqa: E402

NOW = datetime(2026, 10, 2, tzinfo=timezone.utc)

KIND_A_DECL = Declarations(
    key="/ref",
    label="/marking",
    owning_tier="/tier",
    episode=EpisodeDecl(asset="/subject", component="/what/part", fault_code="/what/code"),
    observed_at="/what/seen_at",
    sources="/reports",
    picture="/context",
)


def cm_state(
    *,
    asset_id="dis:1:1:1000",
    edge_id="edge-03",
    region_id=None,
    lifecycle="INSTALLED",
    discrepancies=None,
    originator_nation=None,
    releasable_to=None,
    installed=None,
):
    state: dict = {"asset_id": asset_id, "lifecycle": lifecycle}
    if edge_id is not None:
        state["edge_id"] = edge_id
    if region_id is not None:
        state["region_id"] = region_id
    if discrepancies is not None:
        state["manual_discrepancies"] = discrepancies
    if originator_nation is not None:
        state["originator_nation"] = originator_nation
    if releasable_to is not None:
        state["releasable_to"] = releasable_to
    if installed is not None:
        state["installed"] = installed
    return state


def discrepancy(component="SLOT-1", fault_code="F001", detected_at_ns=1_700_000_000_000_000_000,
                 sources=None):
    return {
        "component": component,
        "fault_code": fault_code,
        "detected_at_ns": detected_at_ns,
        "sources": sources if sources is not None else [{"event_id": "ev-1"}],
    }


# --- assemble() — pure ------------------------------------------------------

def test_assemble_writes_every_declared_pointer():
    state = cm_state(discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, {}, state, episode, picture={}, now=NOW)

    assert record["ref"] == record_key("KindA", "edge-03", "dis:1:1:1000", "SLOT-1", "F001")
    assert record["tier"] == "edge-03"
    assert record["subject"] == "dis:1:1:1000"
    assert record["what"]["part"] == "SLOT-1"
    assert record["what"]["code"] == "F001"
    assert record["what"]["seen_at"] == "2023-11-14T22:13:20Z"
    assert record["reports"] == [{"event_id": "ev-1"}]
    # No label on this cm-state: nothing written at the label pointer at all.
    assert "marking" not in record


def test_assemble_writes_the_label_from_cm_state_when_present():
    state = cm_state(discrepancies=[discrepancy()], originator_nation="BDR", releasable_to=["BDR"])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, {}, state, episode, picture={}, now=NOW)

    assert record["marking"] == {"originator_nation": "BDR", "releasable_to": ["BDR"]}


def test_assemble_owning_tier_falls_back_to_region_id():
    state = cm_state(edge_id=None, region_id="region-hq", discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, {}, state, episode, picture={}, now=NOW)

    assert record["tier"] == "region-hq"


def test_assemble_keeps_only_the_sections_the_schema_names_under_the_picture_pointer():
    """Two sections named at `/context` out of five candidate ones: exactly
    those two survive, in the order the schema lists them or otherwise —
    only membership is asserted, this is not a schema that cares about
    order."""
    schema = {
        "properties": {
            "context": {
                "properties": {"lifecycle": {}, "readiness": {}},
            },
        },
    }
    picture = {
        "lifecycle": "INSTALLED",
        "readiness": {"operational_status": "FMC"},
        "rollup": {"overall_severity": "GREEN"},
        "factors": ["x"],
        "spare": {"on_hand_here": 3},
    }
    state = cm_state(discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, schema, state, episode, picture=picture, now=NOW)

    assert set(record["context"].keys()) == {"lifecycle", "readiness"}
    assert record["context"]["readiness"] == {"operational_status": "FMC"}


def test_assemble_writes_no_picture_section_when_nothing_survives_the_filter():
    schema = {"properties": {"context": {"properties": {"lifecycle": {}}}}}
    state = cm_state(discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, schema, state, episode,
                       picture={"rollup": {"x": 1}}, now=NOW)

    assert "context" not in record


# --- episodes() --------------------------------------------------------------

def test_episodes_skips_an_empty_fault_code():
    """The unkeyed manual-discrepancy path (ADR-0018 §Amendment 2026-08-15):
    present on the wire, never an episode."""
    state = cm_state(discrepancies=[discrepancy(fault_code="")])
    assert episodes(state) == []


def test_episodes_is_empty_once_the_entry_is_gone():
    """There is no resolved/status marker on the real `DiscrepancyRecord` —
    see assembler.py's module docstring. A resolved episode is one simply
    absent from `manual_discrepancies`, modelled here as an empty list."""
    state = cm_state(discrepancies=[])
    assert episodes(state) == []


def test_different_fault_code_is_a_different_key():
    state_a = cm_state(discrepancies=[discrepancy(fault_code="F001")])
    state_b = cm_state(discrepancies=[discrepancy(fault_code="F002")])
    episode_a = episodes(state_a)[0]
    episode_b = episodes(state_b)[0]
    record_a = assemble("KindA", KIND_A_DECL, {}, state_a, episode_a, picture={}, now=NOW)
    record_b = assemble("KindA", KIND_A_DECL, {}, state_b, episode_b, picture={}, now=NOW)
    assert record_a["ref"] != record_b["ref"]


# --- the runner: dedup, revisions, no-record cases --------------------------

async def _no_picture(asset_id):  # noqa: ARG001 — the injected read_asset
    return None


def _route_state():
    route = AssemblerRoute(name="r1", kind="KindA", trigger_topic="t", output_topic="o")
    return _RouteState(route=route, declarations=KIND_A_DECL, schema={})


def _produced(state, cm_state_dict):
    sink: list[tuple[str, bytes, bytes]] = []

    def produce(topic, payload, key):
        sink.append((topic, payload, key))

    asyncio.run(handle_cm_state_message(
        state, cm_state_dict, read_asset=_no_picture, now=NOW, produce=produce))
    return sink


def test_a_second_source_is_a_revision_with_the_same_key_and_both_sources():
    state = _route_state()
    first = cm_state(discrepancies=[discrepancy(sources=[{"event_id": "ev-1"}])])
    sink1 = _produced(state, first)
    assert len(sink1) == 1
    record1 = json.loads(sink1[0][1])
    assert len(record1["reports"]) == 1
    assert state.counters["records"] == 1
    assert state.counters["revisions"] == 0

    second = cm_state(discrepancies=[discrepancy(
        sources=[{"event_id": "ev-1"}, {"event_id": "ev-2"}])])
    sink2 = _produced(state, second)
    assert len(sink2) == 1
    record2 = json.loads(sink2[0][1])
    assert record2["ref"] == record1["ref"]
    assert len(record2["reports"]) == 2
    assert state.counters["records"] == 1
    assert state.counters["revisions"] == 1


def test_the_same_cm_state_again_produces_nothing():
    state = _route_state()
    message = cm_state(discrepancies=[discrepancy()])
    assert len(_produced(state, message)) == 1
    assert len(_produced(state, message)) == 0
    assert state.counters["records"] == 1
    assert state.counters["revisions"] == 0


def test_a_different_fault_code_produces_a_new_record_not_a_revision():
    state = _route_state()
    _produced(state, cm_state(discrepancies=[discrepancy(fault_code="F001")]))
    sink = _produced(state, cm_state(discrepancies=[discrepancy(fault_code="F002")]))
    assert len(sink) == 1
    assert state.counters["records"] == 2
    assert state.counters["revisions"] == 0


def test_an_empty_fault_code_produces_no_record():
    state = _route_state()
    assert _produced(state, cm_state(discrepancies=[discrepancy(fault_code="")])) == []
    assert state.counters == {"records": 0, "revisions": 0, "sources": 0}


def test_a_resolved_discrepancy_absent_from_the_list_produces_no_record():
    state = _route_state()
    assert _produced(state, cm_state(discrepancies=[])) == []


# --- an unlabelled cm-state refuses at the gate, through label_pointer -------

def test_cm_state_without_labels_has_no_marking_and_the_gate_refuses_it_unlabelled():
    state = cm_state(discrepancies=[discrepancy()])  # no originator_nation/releasable_to
    episode = episodes(state)[0]
    record = assemble("KindA", KIND_A_DECL, {}, state, episode, picture={}, now=NOW)
    assert "marking" not in record

    gate = EgressGate(
        "system:dest-a", ["ATL"], accepts=["KindA"], kind="KindA",
        kind_validator=lambda r: None, label_pointer=KIND_A_DECL.label,
    )
    d = gate.decide(record)
    assert not d.allowed and d.reason == REASON_UNLABELLED


# --- the red check end to end, in process -----------------------------------
# A real schema file on disk, loaded through `kinds.py` exactly as `main.py`
# loads one, feeding a real validator and a real `label_pointer` into a real
# `EgressGate` — the only place in this test file nothing is hand-built.

KIND_A_FULL_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["ref", "marking", "tier", "subject", "what", "reports"],
    "properties": {
        "ref": {"type": "string"},
        "marking": {
            "type": "object",
            "properties": {
                "originator_nation": {"type": ["string", "null"]},
                "releasable_to": {"type": "array"},
            },
        },
        "tier": {"type": "string"},
        "subject": {"type": "string"},
        "what": {
            "type": "object",
            "required": ["part", "code"],
            "properties": {
                "part": {"type": "string"},
                "code": {"type": "string"},
                "seen_at": {"type": "string"},
            },
        },
        "reports": {"type": "array"},
        "context": {
            "type": "object",
            "properties": {"lifecycle": {}},
        },
    },
    "x-openddil": {
        "key": "/ref",
        "label": "/marking",
        "owning_tier": "/tier",
        "episode": {"asset": "/subject", "component": "/what/part", "fault_code": "/what/code"},
        "observed_at": "/what/seen_at",
        "sources": "/reports",
        "picture": "/context",
    },
}


def _kind_a_gate(tmp_path, nations):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_FULL_SCHEMA))
    validators = load_kinds(tmp_path)
    declarations = load_declarations(tmp_path)
    decl = declarations["KindA"]
    gate = EgressGate(
        "system:dest-a", nations, accepts=["KindA"], kind="KindA",
        kind_validator=validators["KindA"], label_pointer=decl.label,
    )
    return gate, decl


def test_red_check_bdr_record_against_an_atl_destination_refuses_no_overlap(tmp_path):
    gate, decl = _kind_a_gate(tmp_path, ["ATL"])
    state = cm_state(discrepancies=[discrepancy()], originator_nation="BDR", releasable_to=["BDR"])
    episode = episodes(state)[0]
    record = assemble("KindA", decl, KIND_A_FULL_SCHEMA, state, episode, picture={}, now=NOW)

    assert decl.label == "/marking"
    d = gate.decide(record)
    assert not d.allowed and d.reason == REASON_NO_OVERLAP


def test_red_check_atl_record_against_an_atl_destination_admits(tmp_path):
    gate, decl = _kind_a_gate(tmp_path, ["ATL"])
    state = cm_state(discrepancies=[discrepancy()], originator_nation="ATL", releasable_to=["ATL"])
    episode = episodes(state)[0]
    record = assemble("KindA", decl, KIND_A_FULL_SCHEMA, state, episode, picture={}, now=NOW)

    d = gate.decide(record)
    assert d.allowed and d.reason == ADMIT


def test_assembler_config_refuses_a_kind_not_declared_for_assembly(tmp_path):
    cfg = tmp_path / "assembler.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "KindB",
                                "trigger_topic": "t", "output_topic": "o"}]))
    with pytest.raises(AssemblerConfigError) as exc:
        load_assembler_config(cfg, ["KindA"])
    assert "[0]" in str(exc.value) or "'a'" in str(exc.value)
    assert "KindB" in str(exc.value)


def test_assembler_config_refuses_a_duplicate_name(tmp_path):
    cfg = tmp_path / "assembler.json"
    entry = {"name": "a", "kind": "KindA", "trigger_topic": "t", "output_topic": "o"}
    cfg.write_text(json.dumps([entry, entry]))
    with pytest.raises(AssemblerConfigError) as exc:
        load_assembler_config(cfg, ["KindA"])
    assert "duplicate" in str(exc.value)
