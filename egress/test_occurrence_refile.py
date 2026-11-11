"""End to end, in process: cm-state snapshots -> `assemble` -> the forwarder's
delivery function (`run_once`), on a route that dedupes and cases on `event_id`.

Run: `python -m pytest egress/test_occurrence_refile.py -q` from openddil-demo/.

The contract: `event_id` is the OCCURRENCE id, the same on the opening, every
revision and every arrival re-send, so the forwarder sends once per opening.
A refile after a close is a new occurrence (new first-observed time): a new
event_id, a new POST, a new ledger row. Both carry the same episode_id.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from assembler import AssemblerRoute, _RouteState, episode_key, record_key  # noqa: E402
from forwarder import ForwardRoute, run_once  # noqa: E402
from kinds import Declarations, EpisodeDecl  # noqa: E402
from test_assembler import (  # noqa: E402
    ASSET, NEW_NS, OLD_NS, T0, _feed_cm, _feed_posture, _march_and_move, _tr, cm_state, discrepancy,
)
from test_forwarder import _FakeConsumer, _FakeMessage, _FakeStore, _decode  # noqa: E402

DECL = Declarations(
    key="/event_id", label="/marking", owning_tier="/tier",
    episode=EpisodeDecl(asset="/subject", component="/what/part", fault_code="/what/code"),
    trigger="/kind", provenance="/prov", episode_id="/episode_id",
)
ROUTE = ForwardRoute(
    name="to-a", sink_topic="sink-a", url="http://sink.invalid/ingest", kind="KindA",
    dedupe_field="event_id", case_field="event_id",
)
COMPONENT, FAULT = "SLOT-1", "F001"


def _state():
    route = AssemblerRoute(
        name="r1", kind="KindA", trigger_topic="t", output_topic="o", posture_topic="p")
    return _RouteState(route=route, declarations=DECL, schema={})


def _snapshot(state, ns, event_ids):
    sink: list = []
    _feed_cm(state, cm_state(discrepancies=[discrepancy(
        component=COMPONENT, fault_code=FAULT, detected_at_ns=ns,
        sources=[{"event_id": e} for e in event_ids])]), sink)
    assert len(sink) == 1
    return json.loads(sink[0][1])


class _Wire:
    """Delivers records through `run_once` against one in-memory ledger."""

    def __init__(self):
        self.store = _FakeStore()
        self.posts: list[dict] = []
        self.counts: dict[str, int] = {}

    def post(self, url, data, headers):
        body = json.loads(data)
        record = body["payload"]
        self.posts.append(record)
        return 202, json.dumps({"workflow": {"case_id": record["event_id"]}}).encode()

    def deliver(self, record):
        before = dict(self.counts)
        consumer = _FakeConsumer([_FakeMessage(
            "sink-a", record["event_id"].encode(), json.dumps(record).encode())])
        run_once(
            consumer, routes_by_topic={"sink-a": [ROUTE]}, decode=_decode,
            post=self.post, sleep=lambda d: pytest.fail("no retry expected"),
            poll_timeout=1.0, counts=self.counts, store=self.store,
            log_outcome=lambda *a, **k: None, declarations={"KindA": DECL},
        )
        return {k: v - before.get(k, 0) for k, v in self.counts.items() if v != before.get(k, 0)}


def test_refile_into_an_open_occurrence_is_a_duplicate_and_a_refile_after_close_is_new():
    state, wire = _state(), _Wire()
    e1 = record_key("KindA", "edge-03", ASSET, COMPONENT, FAULT, OLD_NS)
    e2 = record_key("KindA", "edge-03", ASSET, COMPONENT, FAULT, NEW_NS)
    episode = episode_key("KindA", "edge-03", ASSET, COMPONENT, FAULT)

    one = _snapshot(state, OLD_NS, ["ev-1"])
    assert wire.deliver(one) == {"delivered": 1}
    assert len(wire.posts) == 1
    assert wire.store._rows[("to-a", e1)]["case_id"] == e1

    revision = _snapshot(state, OLD_NS, ["ev-1", "ev-2"])
    assert revision["event_id"] == e1
    assert wire.deliver(revision) == {"duplicate": 1}
    assert len(wire.posts) == 1

    three = _snapshot(state, NEW_NS, ["ev-3"])
    assert wire.deliver(three) == {"delivered": 1}
    assert len(wire.posts) == 2
    assert three["event_id"] == e2 != e1
    assert wire.store._rows[("to-a", e2)]["case_id"] == e2

    assert one["episode_id"] == three["episode_id"] == episode

    # An arrival re-send of occurrence 1 (assembled in its own state, as a
    # march order would defer and re-emit it) carries e1 and is a duplicate.
    arrival_state, sink = _state(), []
    _feed_cm(arrival_state, cm_state(discrepancies=[discrepancy(
        component=COMPONENT, fault_code=FAULT, detected_at_ns=OLD_NS)]), sink)
    _march_and_move(arrival_state, sink)
    _feed_posture(arrival_state, _tr("emplaced", "e1", T0 + 300), sink)
    arrival = json.loads(sink[-1][1])
    assert arrival["event_id"] == e1
    assert wire.deliver(arrival) == {"duplicate": 1}
    assert len(wire.posts) == 2

    delivered = [k for k, v in wire.store._rows.items() if v["outcome"] == "delivered"]
    assert sorted(delivered) == sorted([("to-a", e1), ("to-a", e2)])
    assert len(wire.store._rows) == 2
