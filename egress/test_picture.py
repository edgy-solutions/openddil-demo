"""Unit tests for egress/picture.py: the read-only current-picture endpoint.

Run: `python -m pytest egress/test_picture.py -q` from openddil-demo/.

No broker, no PDP, no postgres, no socket: the index is fed directly, and
`read_asset` and `gate_for` are injected.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from assembler import (  # noqa: E402
    AssemblerRoute,
    PartsBook,
    _RouteState,
    assemble,
    build_picture,
    episodes,
    record_key,
)
from gate import ADMIT, REASON_NO_OVERLAP, AuthzUnavailable, EgressGate  # noqa: E402
from picture import EpisodeIndex, answer, picture_enabled  # noqa: E402
from test_assembler import (  # noqa: E402
    KIND_A_DECL,
    NOW,
    _parts_book,
    cm_state,
    discrepancy,
)

ROUTE = AssemblerRoute(
    name="r1", kind="KindA", trigger_topic="cm", output_topic="out",
    part_refs=(("SLOT-1", "part:x"),),
)


def _key(state, disc_kwargs, kind="KindA"):
    tier = state.get("edge_id") or state.get("region_id") or ""
    d = discrepancy(**disc_kwargs)
    return record_key(kind, tier, state["asset_id"], d["component"],
                      d["fault_code"], d["detected_at_ns"])


# --- the index --------------------------------------------------------------

def test_index_keys_each_fault_coded_episode_by_record_key():
    idx = EpisodeIndex()
    state = cm_state(discrepancies=[
        discrepancy(component="SLOT-1", fault_code="F001"),
        discrepancy(component="SLOT-2", fault_code="F002", detected_at_ns=5),
    ])
    idx.update(ROUTE, state)
    k1 = _key(state, {"component": "SLOT-1", "fault_code": "F001"})
    k2 = _key(state, {"component": "SLOT-2", "fault_code": "F002", "detected_at_ns": 5})
    assert idx.lookup(k1).episode.component == "SLOT-1"
    assert idx.lookup(k2).episode.component == "SLOT-2"
    assert idx.lookup(k1).owning_tier == "edge-03"
    assert idx.lookup(k1).route is ROUTE


def test_index_skips_an_empty_fault_code():
    idx = EpisodeIndex()
    state = cm_state(discrepancies=[discrepancy(fault_code="")])
    idx.update(ROUTE, state)
    assert idx.lookup(_key(state, {"fault_code": ""})) is None
    assert len(idx) == 0


def test_a_later_message_without_the_episode_removes_its_key():
    idx = EpisodeIndex()
    two = cm_state(discrepancies=[discrepancy(component="SLOT-1"),
                                  discrepancy(component="SLOT-2", fault_code="F002")])
    idx.update(ROUTE, two)
    gone = _key(two, {"component": "SLOT-2", "fault_code": "F002"})
    kept = _key(two, {"component": "SLOT-1"})
    idx.update(ROUTE, cm_state(discrepancies=[discrepancy(component="SLOT-1")]))
    assert idx.lookup(gone) is None
    assert idx.lookup(kept) is not None


def test_a_message_for_another_asset_leaves_the_first_assets_keys():
    idx = EpisodeIndex()
    a = cm_state(asset_id="dis:1:1:1", discrepancies=[discrepancy()])
    b = cm_state(asset_id="dis:1:1:2", discrepancies=[discrepancy()])
    idx.update(ROUTE, a)
    idx.update(ROUTE, b)
    idx.update(ROUTE, cm_state(asset_id="dis:1:1:2", discrepancies=[]))
    assert idx.lookup(_key(a, {})) is not None
    assert idx.lookup(_key(b, {})) is None


def test_tombstone_removes_the_assets_entries():
    idx = EpisodeIndex()
    a = cm_state(discrepancies=[discrepancy()])
    idx.update(ROUTE, a)
    idx.remove(ROUTE, a["asset_id"])
    assert idx.lookup(_key(a, {})) is None


def test_owning_tier_falls_back_to_region_id():
    idx = EpisodeIndex()
    state = cm_state(edge_id=None, region_id="region-b", discrepancies=[discrepancy()])
    idx.update(ROUTE, state)
    entry = idx.lookup(_key(state, {}))
    assert entry is not None and entry.owning_tier == "region-b"


# --- answer() ---------------------------------------------------------------

async def _asset(asset_id):  # noqa: ARG001
    return {"readiness": {"state": "ok"}}


async def _asset_boom(asset_id):  # noqa: ARG001
    raise RuntimeError("postgres down")


def _fixture(nations=("ATL",), label=("ATL", ["ATL"])):
    state = cm_state(discrepancies=[discrepancy()],
                     originator_nation=label[0], releasable_to=label[1])
    idx = EpisodeIndex()
    idx.update(ROUTE, state)
    rs = _RouteState(route=ROUTE, declarations=KIND_A_DECL, schema={},
                     parts=_parts_book())
    gate = EgressGate("dest-a", nations, accepts=["KindA"], kind="KindA",
                      policy_version="p1", corpus_version="c1")
    return state, idx, {ROUTE.name: rs}, gate, _key(state, {})


def _call(event_id, destination, idx, rs, gate=None, read=_asset, gate_for=None):
    return answer(
        event_id, destination, index=idx, routes_state=rs, read_asset=read,
        gate_for=gate_for or (lambda d, k: gate), now=NOW)


@pytest.mark.parametrize("event_id,destination", [
    (None, "dest-a"), ("", "dest-a"), ("x", None), ("x", ""),
])
def test_missing_arguments_are_400(event_id, destination):
    _, idx, rs, gate, _ = _fixture()
    status, body = _call(event_id, destination, idx, rs, gate)
    assert status == 400 and "detail" in body


def test_unknown_event_id_is_404():
    _, idx, rs, gate, _ = _fixture()
    status, body = _call("nope", "dest-a", idx, rs, gate)
    assert status == 404
    assert body == {"detail": "unknown event_id: no open episode has this id"}


def test_admit_returns_the_record_assemble_gives():
    import asyncio
    state, idx, rs, gate, key = _fixture()
    status, body = _call(key, "dest-a", idx, rs, gate)
    assert status == 200
    ep = episodes(state)[0]
    pic = asyncio.run(build_picture(
        state, ep, "edge-03", read_asset=_asset, parts=rs["r1"].parts,
        part_refs=dict(ROUTE.part_refs), designations={}))
    assert body["record"] == assemble("KindA", KIND_A_DECL, {}, state, ep, pic, NOW)
    assert body["event_id"] == key and body["kind"] == "KindA"
    assert body["destination"] == "dest-a"
    assert body["decision_id"]
    assert (body["policy_version"], body["corpus_version"]) == ("p1", "c1")


def test_refuse_is_403_with_reason_and_no_record():
    _, idx, rs, gate, key = _fixture(nations=("BDR",))
    status, body = _call(key, "dest-a", idx, rs, gate)
    assert status == 403
    assert body["reason"] == REASON_NO_OVERLAP
    assert "record" not in body
    assert body["decision_id"] and body["event_id"] == key
    assert body["destination"] == "dest-a"
    assert body["policy_version"] == "p1"


def test_pdp_unavailable_is_503():
    _, idx, rs, _, key = _fixture()

    def boom(d, k):
        raise AuthzUnavailable("down")

    status, body = _call(key, "dest-a", idx, rs, gate_for=boom)
    assert (status, body) == (503, {"detail": "authorization unavailable"})


def test_read_failure_is_503_without_a_record():
    _, idx, rs, gate, key = _fixture()
    status, body = _call(key, "dest-a", idx, rs, gate, read=_asset_boom)
    assert (status, body) == (503, {"detail": "picture unavailable"})


# --- gating -----------------------------------------------------------------

def test_off_by_default():
    assert picture_enabled({}) is False
    assert picture_enabled({"OPENDDIL_PICTURE_ENABLED": "0"}) is False
    assert picture_enabled({"OPENDDIL_PICTURE_ENABLED": "1"}) is True
    assert picture_enabled({"OPENDDIL_PICTURE_ENABLED": "True"}) is True
