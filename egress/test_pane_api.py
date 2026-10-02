"""Unit tests for egress/pane_api.py's per-destination record source
(ADR-0046 s5) and the work-order fields it carries beside each decision.

Run: `python -m pytest egress/test_pane_api.py -q` from openddil-demo/.

No Postgres, no Topaz: `build_decisions` is exercised with its two I/O
seams (`EgressGate.for_destination` and the `RECORD_SOURCE` map's fetch
functions) replaced with fixtures, exactly the way test_gate.py injects the
PDP answer instead of fetching it. `EgressGate.decide` itself is never
stubbed — every assertion here is about the real predicate's answer over a
replaced record source, not a paraphrase of it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import pane_api  # noqa: E402
from gate import REASON_NO_OVERLAP, REASON_UNLABELLED, EgressGate  # noqa: E402


def _gate(destination: str, nations: list[str]) -> EgressGate:
    return EgressGate(
        destination, nations,
        policy_version="test-policy", corpus_version="test-corpus",
    )


def _patch_gate(monkeypatch: pytest.MonkeyPatch, nations: list[str]) -> None:
    """`for_destination` normally asks Topaz. Every test here supplies the
    PDP's answer directly, keyed only by the nations the destination is
    entitled to -- same seam test_gate.py uses."""
    monkeypatch.setattr(
        pane_api.EgressGate, "for_destination",
        classmethod(lambda cls, destination: _gate(destination, nations)),
    )


def _action(action_id: str, originator: str | None = None,
            releasable: list[str] | None = None) -> dict:
    return {
        "action_id": action_id,
        "event_id": f"{action_id}-event",
        "asset_id": f"{action_id}-asset",
        "owning_tier": "edge-01",
        "originator_nation": originator,
        "releasable_to": releasable or [],
        "work_order": {"task": "remove and replace array module"},
        "approval_chain": [],
        "provenance": {},
        "decided_at": "2026-10-02T00:00:00+00:00",
    }


def _asset(asset_id: str, originator: str | None = None,
           releasable: list[str] | None = None) -> dict:
    return {
        "asset_id": asset_id,
        "originator_nation": originator,
        "releasable_to": releasable or [],
    }


def test_mmis_destination_decides_action_rows_per_label(monkeypatch):
    """ATL / BDR / ATL+BDR actions are all admitted to an ATL+BDR
    destination; an unlabelled action is refused `unlabelled` -- the same
    deny-unlabelled floor the asset path enforces, now over the second
    record source."""
    actions = [
        _action("fixture-maint-1", originator="ATL"),
        _action("fixture-maint-2", originator="BDR"),
        _action("fixture-maint-3", originator="ATL", releasable=["BDR"]),
        _action("fixture-maint-4"),  # unlabelled
    ]

    async def fake_fetch():
        return actions

    monkeypatch.setitem(pane_api.RECORD_SOURCE, "system:mmis-stand-in", fake_fetch)
    _patch_gate(monkeypatch, ["ATL", "BDR"])

    result = pane_api.build_decisions("system:mmis-stand-in")

    assert result["admitted"] == 3
    assert result["refused"] == 1
    by_id = {r["action_id"]: r for r in result["records"]}
    assert by_id["fixture-maint-1"]["allowed"] is True
    assert by_id["fixture-maint-2"]["allowed"] is True
    assert by_id["fixture-maint-3"]["allowed"] is True
    assert by_id["fixture-maint-4"]["allowed"] is False
    assert by_id["fixture-maint-4"]["reason"] == REASON_UNLABELLED

    # Work-order fields ride beside the decision.
    admitted_row = by_id["fixture-maint-1"]
    assert admitted_row["event_id"] == "fixture-maint-1-event"
    assert admitted_row["owning_tier"] == "edge-01"
    assert admitted_row["work_order"] == {"task": "remove and replace array module"}
    assert admitted_row["approval_chain"] == []
    assert admitted_row["decided_at"] == "2026-10-02T00:00:00+00:00"
    assert "provenance" in admitted_row


def test_c2_destination_still_reads_asset_rows_only(monkeypatch):
    """`RECORD_SOURCE` has no entry for a c2 destination: the map falls
    through to `_fetch_all_records`, exactly as every destination did before
    this map existed. The maintenance fetch must not even be called."""
    calls = {"asset": 0, "action": 0}

    async def fake_assets():
        calls["asset"] += 1
        return [_asset("dis:1:1:1000", originator="ATL")]

    async def fake_actions():
        calls["action"] += 1
        return []

    monkeypatch.setattr(pane_api, "_fetch_all_records", fake_assets)
    monkeypatch.setitem(pane_api.RECORD_SOURCE, "system:mmis-stand-in", fake_actions)
    _patch_gate(monkeypatch, ["ATL"])

    result = pane_api.build_decisions("system:c2-stand-in-atl")

    assert calls == {"asset": 1, "action": 0}
    assert result["records"][0]["asset_id"] == "dis:1:1:1000"
    # No work-order field leaks onto an asset row.
    assert "work_order" not in result["records"][0]


def test_unknown_destination_reads_asset_rows_same_as_today(monkeypatch):
    """A destination absent from both the entitlements corpus and
    `RECORD_SOURCE` still reads `asset_logistics_status` -- unchanged from
    before this map existed. Whether it is ENTITLED to anything is a
    question for `EgressGate.decide` (`destination_unknown`), never for the
    record-source map."""
    calls = {"asset": 0}

    async def fake_assets():
        calls["asset"] += 1
        return []

    monkeypatch.setattr(pane_api, "_fetch_all_records", fake_assets)
    _patch_gate(monkeypatch, [])

    pane_api.build_decisions("system:nobody-declared-this")

    assert calls["asset"] == 1


def test_atl_only_destination_refuses_a_bdr_originated_action():
    """Unit level, straight through `gate.decide` -- ADR-0046 s2's red-check
    restated for the action-in direction (s5): a BDR-originated action,
    decided by a destination entitled to ATL only, is refused
    no_nation_overlap, not admitted."""
    gate = _gate("system:c2-stand-in-atl", ["ATL"])
    action = _action("fixture-bdr-action", originator="BDR")

    decision = gate.decide(
        {"originator_nation": action["originator_nation"],
         "releasable_to": action["releasable_to"]},
        key=action["action_id"],
    )

    assert decision.allowed is False
    assert decision.reason == REASON_NO_OVERLAP
