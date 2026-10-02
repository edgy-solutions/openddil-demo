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
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import delivery  # noqa: E402
from assembler import (  # noqa: E402
    AssemblerConfigError,
    AssemblerRoute,
    _RouteState,
    _make_produce,
    Designation,
    PartsBook,
    assemble,
    build_picture,
    episodes,
    handle_cm_state_message,
    load_assembler_config,
    record_key,
)
from gate import ADMIT, REASON_NO_OVERLAP, REASON_UNLABELLED, EgressGate  # noqa: E402
from kinds import Declarations, EpisodeDecl, load_declarations, load_kinds, validator_for  # noqa: E402

TESTDATA = Path(__file__).parent / "testdata"

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


# --- lifecycle: the enum name, not the wire integer --------------------------

# Reuses KIND_A_DECL's own pointers (`/context` for the picture) rather than
# a second declarations fixture — the point here is the VALUE at
# `lifecycle`, not where it lands.
LIFECYCLE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "context": {
            "type": "object",
            "properties": {"lifecycle": {"type": ["string", "null"]}},
        },
    },
}


def _assembled_lifecycle(lifecycle_value):
    state = cm_state(lifecycle=lifecycle_value, discrepancies=[discrepancy()])
    episode = episodes(state)[0]
    picture = asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_no_picture, parts=PartsBook()))
    return assemble("KindA", KIND_A_DECL, LIFECYCLE_SCHEMA, state, episode, picture, NOW)


def test_an_integer_lifecycle_is_normalised_to_its_enum_name_and_validates():
    record = _assembled_lifecycle(2)
    assert record["context"]["lifecycle"] == "LIFECYCLE_ACTIVE"
    error = validator_for(LIFECYCLE_SCHEMA)(record)
    assert error is None, error


def test_a_string_lifecycle_passes_through_unchanged():
    record = _assembled_lifecycle("INSTALLED")
    assert record["context"]["lifecycle"] == "INSTALLED"


def test_an_unknown_integer_lifecycle_becomes_none_and_warns(caplog):
    with caplog.at_level(logging.WARNING, logger="egress.assembler"):
        record = _assembled_lifecycle(999)
    assert record["context"]["lifecycle"] is None
    messages = [r.getMessage() for r in caplog.records]
    assert any("999" in m and "dis:1:1:1000" in m for m in messages)


# --- lifecycle on a real captured hub record ---------------------------------

FAULT_EVENT_DECL = Declarations(
    key="/id",
    label="/label",
    owning_tier="/owning_tier",
    episode=EpisodeDecl(asset="/asset", component="/component", fault_code="/fault_code"),
    observed_at="/observed_at",
    sources="/sources",
    picture="/picture",
)


def _load_testdata(name):
    return json.loads((TESTDATA / name).read_text())


async def _some_readiness_and_rollup(asset_id):  # noqa: ARG001 — the injected read_asset
    # `fault-event.schema.json` requires `readiness`/`battle_condition` in
    # the picture; `_no_picture` (no hub postgres row) would leave both
    # absent, which is a real, valid outcome `assemble` handles fine but
    # not what this test is isolating — the lifecycle normalisation.
    return {"readiness": {"operational_status": "FMC"}, "rollup": {"overall_severity": 1}}


def test_real_open_episode_hub_record_normalises_lifecycle_and_validates():
    """`hub-asset-cm-state-open-episode.json` is a real captured hub
    `asset-cm-state` message — proto3 JSON, so `lifecycle` (and every other
    enum on it) arrives as a bare integer, not a name. This is the shape
    that made every assembled record fail `schema_invalid` before the fix:
    run against the unfixed `_lifecycle_name`, this test fails because
    `record["picture"]["lifecycle"]` is the int `2`, which the schema below
    refuses (only `string`/`null` are allowed there)."""
    state = _load_testdata("hub-asset-cm-state-open-episode.json")
    found = episodes(state)
    assert len(found) == 1
    episode = found[0]

    picture = asyncio.run(build_picture(
        state, episode, state.get("edge_id") or state.get("region_id") or "",
        read_asset=_some_readiness_and_rollup, parts=PartsBook()))
    schema = _load_testdata("fault-event.schema.json")
    record = assemble("FaultEvent", FAULT_EVENT_DECL, schema, state, episode, picture, NOW)

    error = validator_for(schema)(record)
    assert error is None, error
    assert record["picture"]["lifecycle"] == "LIFECYCLE_ACTIVE"


def test_real_no_episode_hub_record_yields_zero_episodes():
    state = _load_testdata("hub-asset-cm-state-no-episode.json")
    assert episodes(state) == []


# --- no "produced" bookkeeping before delivery is confirmed ------------------

class _FakeDeliveryProducer:
    """Mimics confluent_kafka.Producer's async-delivery shape: `produce`
    only queues a callback, `flush` is what actually invokes it — the same
    two calls `delivery.send_one` makes against a real producer."""

    def __init__(self, *, fail=False):
        self.fail = fail
        self.sent: list[tuple[str, bytes, bytes]] = []
        self._pending = []

    def produce(self, topic, value=None, key=None, callback=None):
        self.sent.append((topic, value, key))
        self._pending.append((callback, topic, key))

    def flush(self, timeout):
        for callback, topic, key in self._pending:
            if callback is not None:
                callback(f"boom:{topic}:{key!r}" if self.fail else None, None)
        self._pending.clear()
        return 0


def test_the_real_produce_closure_raises_when_the_broker_never_confirms():
    """`_make_produce` is the entire fix: before it existed, `_main_async`
    built `produce` from a bare `producer.produce()` + `poll(0)`, which
    never raised no matter what the broker did, so a silently failed
    produce looked exactly like a successful one. This fails on that old
    closure (there is no `_make_produce` to import) and on any closure that
    does not wait for the delivery report."""
    failing = _FakeDeliveryProducer(fail=True)
    produce = _make_produce(failing)
    with pytest.raises(delivery.DeliveryFailed):
        produce("sink-topic", b"payload", b"key")


def test_the_real_produce_closure_returns_once_delivery_is_confirmed():
    succeeding = _FakeDeliveryProducer(fail=False)
    produce = _make_produce(succeeding)
    produce("sink-topic", b"payload", b"key")  # must not raise
    assert succeeding.sent == [("sink-topic", b"payload", b"key")]


def test_a_failed_delivery_raises_and_leaves_bookkeeping_unchanged_then_a_retry_succeeds():
    state = _route_state()
    message = cm_state(discrepancies=[discrepancy()])

    failing = _FakeDeliveryProducer(fail=True)
    with pytest.raises(delivery.DeliveryFailed):
        asyncio.run(handle_cm_state_message(
            state, message, read_asset=_no_picture, now=NOW, produce=_make_produce(failing)))
    assert state.last_produced == {}
    assert state.counters == {"records": 0, "revisions": 0, "sources": 0}

    succeeding = _FakeDeliveryProducer(fail=False)
    asyncio.run(handle_cm_state_message(
        state, message, read_asset=_no_picture, now=NOW, produce=_make_produce(succeeding)))
    assert len(succeeding.sent) == 1
    assert state.counters["records"] == 1
    assert state.counters["revisions"] == 0


def test_happy_path_counters_and_last_produced_advance_only_after_delivery():
    state = _route_state()
    message = cm_state(discrepancies=[discrepancy()])
    producer = _FakeDeliveryProducer(fail=False)

    asyncio.run(handle_cm_state_message(
        state, message, read_asset=_no_picture, now=NOW, produce=_make_produce(producer)))

    assert len(producer.sent) == 1
    assert state.counters["records"] == 1
    assert len(state.last_produced) == 1


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


# --- the spare section: installed CI, then the deployment's slot map --------

def _parts_book():
    book = PartsBook()
    for site, n in (("edge-03", 0), ("region-b", 2)):
        book.ingest({"site": site, "part_ref": "part:x", "item": "x unit", "on_hand": n})
    return book


def _picture(state, episode, part_refs=None):
    return asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_no_picture, parts=_parts_book(),
        part_refs=part_refs))


def test_an_empty_ci_id_takes_the_part_the_slot_map_names():
    state = cm_state(discrepancies=[discrepancy()],
                     installed=[{"slot_id": "SLOT-1", "ci_id": "", "installed_at_ns": 0}])
    picture = _picture(state, episodes(state)[0], part_refs={"SLOT-1": "part:x"})
    assert picture["spare"] == {"part_ref": "part:x", "item": "x unit",
                                "on_hand_here": 0, "on_hand": {"edge-03": 0, "region-b": 2}}


def test_an_empty_ci_id_and_no_slot_map_leaves_the_spare_absent():
    state = cm_state(discrepancies=[discrepancy()],
                     installed=[{"slot_id": "SLOT-1", "ci_id": "", "installed_at_ns": 0}])
    assert "spare" not in _picture(state, episodes(state)[0])


def test_assembler_config_refuses_a_part_refs_that_is_not_a_string_map(tmp_path):
    cfg = tmp_path / "assembler.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "KindA", "trigger_topic": "t",
                                "output_topic": "o", "part_refs": {"SLOT-1": 3}}]))
    with pytest.raises(AssemblerConfigError) as exc:
        load_assembler_config(cfg, ["KindA"])
    assert "part_refs" in str(exc.value)


# --- the spares section -------------------------------------------------

def test_partsbook_lookup_builds_a_spares_entry_per_site_sorted_by_site():
    book = PartsBook()
    book.ingest({"site": "site-b", "part_ref": "part:p-1", "item": "widget", "on_hand": 2})
    book.ingest({"site": "site-a", "part_ref": "part:p-1", "item": "widget", "on_hand": 5,
                 "lead_time_days": 0, "source": "feed-a", "as_of": 1_700_000_000_000_000_000})

    spare = book.lookup("part:p-1", "site-a")

    assert spare["spares"] == [
        {"site": "site-a", "on_hand": 5, "lead_time_days": 0,
         "source": "feed-a", "as_of": "2023-11-14T22:13:20Z"},
        {"site": "site-b", "on_hand": 2},
    ]


def test_build_picture_emits_spares_as_its_own_section_next_to_unchanged_spare():
    book = PartsBook()
    book.ingest({"site": "site-a", "part_ref": "part:p-1", "item": "widget", "on_hand": 5})
    book.ingest({"site": "site-b", "part_ref": "part:p-1", "item": "widget", "on_hand": 2})
    state = cm_state(discrepancies=[discrepancy(component="slot-a")],
                      installed=[{"slot_id": "slot-a", "ci_id": "", "installed_at_ns": 0}])

    picture = asyncio.run(build_picture(
        state, episodes(state)[0], "site-a", read_asset=_no_picture, parts=book,
        part_refs={"slot-a": "part:p-1"}))

    assert picture["spare"] == {"part_ref": "part:p-1", "item": "widget",
                                 "on_hand_here": 5, "on_hand": {"site-a": 5, "site-b": 2}}
    assert picture["spares"] == [
        {"site": "site-a", "on_hand": 5},
        {"site": "site-b", "on_hand": 2},
    ]


# --- the battle_condition section ---------------------------------------

async def _rollup_only(asset_id):  # noqa: ARG001 — the injected read_asset
    return {"readiness": None, "rollup": {"overall_severity": "RED"}, "factors": None}


def test_build_picture_battle_condition_merges_rollup_and_designation():
    state = cm_state(asset_id="asset-1", discrepancies=[discrepancy()])
    episode = episodes(state)[0]
    designations = {"asset-1": Designation(mission_essential=True, basis="primary strike asset")}

    picture = asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_rollup_only, parts=PartsBook(),
        designations=designations))

    assert picture["battle_condition"] == {
        "overall_severity": "RED", "mission_essential": True, "basis": "primary strike asset"}


def test_build_picture_battle_condition_undesignated_has_no_mission_essential_key():
    state = cm_state(asset_id="asset-2", discrepancies=[discrepancy()])
    episode = episodes(state)[0]
    designations = {"asset-1": Designation(mission_essential=True, basis="x")}

    picture = asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_rollup_only, parts=PartsBook(),
        designations=designations))

    assert picture["battle_condition"] == {"overall_severity": "RED"}
    assert "mission_essential" not in picture["battle_condition"]
    assert "basis" not in picture["battle_condition"]


def test_build_picture_battle_condition_absent_with_neither_rollup_nor_designation():
    state = cm_state(discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    picture = asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_no_picture, parts=PartsBook()))

    assert "battle_condition" not in picture


def test_load_assembler_config_battle_condition_loads_cleanly(tmp_path):
    cfg = tmp_path / "assembler.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "KindA", "trigger_topic": "t",
                                "output_topic": "o",
                                "battle_condition": {"asset-1": {
                                    "mission_essential": True, "basis": "primary strike asset"}}}]))

    routes = load_assembler_config(cfg, ["KindA"])

    assert dict(routes[0].battle_condition) == {
        "asset-1": Designation(mission_essential=True, basis="primary strike asset")}


def test_load_assembler_config_battle_condition_non_bool_mission_essential_raises(tmp_path):
    cfg = tmp_path / "assembler.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "KindA", "trigger_topic": "t",
                                "output_topic": "o",
                                "battle_condition": {"asset-1": {
                                    "mission_essential": "yes", "basis": "x"}}}]))

    with pytest.raises(AssemblerConfigError) as exc:
        load_assembler_config(cfg, ["KindA"])
    assert "asset-1" in str(exc.value)


def test_load_assembler_config_battle_condition_empty_basis_raises(tmp_path):
    cfg = tmp_path / "assembler.json"
    cfg.write_text(json.dumps([{"name": "a", "kind": "KindA", "trigger_topic": "t",
                                "output_topic": "o",
                                "battle_condition": {"asset-1": {
                                    "mission_essential": True, "basis": ""}}}]))

    with pytest.raises(AssemblerConfigError) as exc:
        load_assembler_config(cfg, ["KindA"])
    assert "asset-1" in str(exc.value)


def test_battle_condition_requiring_mission_essential_fails_validator_for_undesignated_asset(tmp_path):
    """The gate's own schema, not the assembler, is what makes this
    fail-closed: a schema that requires `/picture/battle_condition/
    mission_essential` sees a `context.battle_condition` with no
    `mission_essential` key and refuses the record — exactly the
    schema_invalid path the rule describes."""
    schema = json.loads(json.dumps(KIND_A_FULL_SCHEMA))  # deep copy
    schema["properties"]["context"] = {
        "type": "object",
        "properties": {
            "battle_condition": {
                "type": "object",
                "required": ["mission_essential"],
                "properties": {
                    "overall_severity": {"type": "string"},
                    "mission_essential": {"type": "boolean"},
                    "basis": {"type": "string"},
                },
            },
        },
    }
    (tmp_path / "KindA.schema.json").write_text(json.dumps(schema))
    validators = load_kinds(tmp_path)
    decl = load_declarations(tmp_path)["KindA"]

    state = cm_state(discrepancies=[discrepancy()], originator_nation="ATL", releasable_to=["ATL"])
    episode = episodes(state)[0]
    record = assemble("KindA", decl, schema, state, episode,
                       picture={"battle_condition": {"overall_severity": "RED"}}, now=NOW)

    assert record["context"]["battle_condition"] == {"overall_severity": "RED"}
    assert validators["KindA"](record) is not None


# --- provenance[] -------------------------------------------------------

PROVENANCE_DECL = Declarations(
    key="/ref", label="/marking", owning_tier="/tier",
    episode=EpisodeDecl(asset="/subject", component="/what/part", fault_code="/what/code"),
    picture="/context", provenance="/prov",
)


def test_assemble_no_provenance_key_when_not_declared():
    state = cm_state(discrepancies=[discrepancy()])
    episode = episodes(state)[0]

    record = assemble("KindA", KIND_A_DECL, {}, state, episode, picture={}, now=NOW)

    assert "prov" not in record


def test_assemble_provenance_omits_cm_state_observed_at_when_missing():
    state = cm_state(discrepancies=[discrepancy()])  # no last_observed_at_ns
    episode = episodes(state)[0]

    record = assemble("KindA", PROVENANCE_DECL, {}, state, episode, picture={}, now=NOW)

    assert record["prov"] == [{"row_key": "asset_cm_state:dis:1:1:1000"}]


def test_assemble_provenance_lists_sources_in_order_with_their_own_timestamps():
    """Every observed_at below is a value injected into the fixture, never
    `NOW` — proving the assembler's own clock is never consulted."""
    state = cm_state(discrepancies=[discrepancy()])
    state["last_observed_at_ns"] = 1_700_000_000_000_000_000
    episode = episodes(state)[0]
    picture = {
        "readiness": {"operational_status": "FMC"},
        "readiness_observed_at": "2026-01-01T00:00:00Z",
        "rollup": {"overall_severity": "GREEN"},
        "rollup_observed_at": "2026-01-02T00:00:00Z",
        "spare": {"part_ref": "part:p-1", "item": "widget", "on_hand_here": 5,
                  "on_hand": {"site-a": 5, "site-b": 2}},
        "spares": [
            {"site": "site-a", "on_hand": 5, "as_of": "2026-01-03T00:00:00Z"},
            {"site": "site-b", "on_hand": 2},
        ],
    }

    record = assemble("KindA", PROVENANCE_DECL, {}, state, episode, picture=picture, now=NOW)

    assert record["prov"] == [
        {"row_key": "asset_cm_state:dis:1:1:1000", "observed_at": "2023-11-14T22:13:20Z"},
        {"row_key": "telemetry_latest_state:dis:1:1:1000", "observed_at": "2026-01-01T00:00:00Z"},
        {"row_key": "asset_logistics_status:dis:1:1:1000", "observed_at": "2026-01-02T00:00:00Z"},
        {"row_key": "parts-availability:site-a:part:p-1", "observed_at": "2026-01-03T00:00:00Z"},
        {"row_key": "parts-availability:site-b:part:p-1"},
    ]


def test_assemble_provenance_omits_a_source_that_contributed_nothing():
    state = cm_state(discrepancies=[discrepancy()])
    state["last_observed_at_ns"] = 1_700_000_000_000_000_000
    episode = episodes(state)[0]

    record = assemble("KindA", PROVENANCE_DECL, {}, state, episode, picture={}, now=NOW)

    assert record["prov"] == [
        {"row_key": "asset_cm_state:dis:1:1:1000", "observed_at": "2023-11-14T22:13:20Z"}]


def test_provenance_end_to_end_through_build_picture_and_assemble():
    """`read_asset`'s injected timestamps thread all the way through
    `build_picture` into `assemble`'s provenance list — the seam the rule
    requires stays DB-free."""
    async def _reading(asset_id):  # noqa: ARG001
        return {
            "readiness": {"operational_status": "FMC", "reporting_status": "REPORTING"},
            "rollup": {"overall_severity": "GREEN"},
            "factors": [],
            "readiness_observed_at": "2026-02-01T00:00:00Z",
            "rollup_observed_at": "2026-02-02T00:00:00Z",
        }

    book = PartsBook()
    book.ingest({"site": "site-a", "part_ref": "part:p-1", "item": "widget",
                 "on_hand": 5, "as_of": 1_700_000_000_000_000_000})

    state = cm_state(discrepancies=[discrepancy(component="slot-a")],
                      installed=[{"slot_id": "slot-a", "ci_id": "", "installed_at_ns": 0}])
    state["last_observed_at_ns"] = 1_700_000_000_000_000_000
    episode = episodes(state)[0]

    picture = asyncio.run(build_picture(
        state, episode, "edge-03", read_asset=_reading, parts=book,
        part_refs={"slot-a": "part:p-1"}))

    record = assemble("KindA", PROVENANCE_DECL, {}, state, episode, picture=picture, now=NOW)

    row_keys = [entry["row_key"] for entry in record["prov"]]
    assert row_keys == [
        "asset_cm_state:dis:1:1:1000",
        "telemetry_latest_state:dis:1:1:1000",
        "asset_logistics_status:dis:1:1:1000",
        "parts-availability:site-a:part:p-1",
    ]
    by_key = {entry["row_key"]: entry.get("observed_at") for entry in record["prov"]}
    assert by_key["telemetry_latest_state:dis:1:1:1000"] == "2026-02-01T00:00:00Z"
    assert by_key["asset_logistics_status:dis:1:1:1000"] == "2026-02-02T00:00:00Z"
    assert by_key["parts-availability:site-a:part:p-1"] == "2023-11-14T22:13:20Z"
