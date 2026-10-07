"""Unit tests for egress/pane_api.py's `kind`-selected record path
(ADR-0046 s5) and the no-`kind` asset path it must leave unchanged.

Run: `python -m pytest egress/test_pane_api.py -q` from openddil-demo/.

No Postgres, no Topaz: `build_decisions` is exercised with its two I/O
seams (`EgressGate.for_destination` and `_fetch_records_by_kind` /
`_fetch_all_records`) replaced with fixtures, exactly the way test_gate.py
injects the PDP answer instead of fetching it. `EgressGate.decide` itself is
never stubbed — every assertion here is about the real predicate's answer
over a replaced record source, not a paraphrase of it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import pane_api  # noqa: E402
from gate import (  # noqa: E402
    REASON_KIND_NOT_ACCEPTED,
    REASON_NO_OVERLAP,
    REASON_UNLABELLED,
    EgressGate,
)


def _gate(destination: str, nations: list[str], *, kind: str | None = None,
          accepts: list[str] = ()) -> EgressGate:
    return EgressGate(
        destination, nations, kind=kind, accepts=accepts,
        policy_version="test-policy", corpus_version="test-corpus",
    )


def _patch_gate(monkeypatch: pytest.MonkeyPatch, nations: list[str], *,
                 accepts: list[str] = ()) -> None:
    """`for_destination` normally asks Topaz. Every test here supplies the
    PDP's answer directly, keyed only by the nations (and, for the kind
    path, the accepts list) the destination is entitled to -- same seam
    test_gate.py uses."""
    monkeypatch.setattr(
        pane_api.EgressGate, "for_destination",
        classmethod(lambda cls, destination, *, kind=None, **kw: _gate(
            destination, nations, kind=kind, accepts=accepts)),
    )


def _record(key: str, originator: str | None = None,
            releasable: list[str] | None = None, *, asset_id: str | None = None,
            owning_tier: str = "edge-01",
            decided_at: str = "2026-10-02T00:00:00+00:00",
            intake: dict | None = None) -> dict:
    return {
        "intake_decision": intake if intake is not None else {
            "allowed": True, "reason": None,
            "decision_id": f"intake-{key}", "provisional": False,
        },
        "key": key,
        "originator_nation": originator,
        "releasable_to": releasable or [],
        "owning_tier": owning_tier,
        "body": {"asset_id": asset_id} if asset_id else {},
        "decided_at": decided_at,
    }


def _asset(asset_id: str, originator: str | None = None,
           releasable: list[str] | None = None) -> dict:
    return {"asset_id": asset_id, "originator_nation": originator,
            "releasable_to": releasable or []}


def test_kind_path_decides_rows_through_the_real_gate(monkeypatch):
    """ATL / BDR / ATL+BDR records are all admitted to an ATL+BDR
    destination that accepts this kind; an unlabelled record is refused
    `unlabelled` -- the same deny-unlabelled floor the asset path enforces,
    now over the generic record store."""
    records = [
        _record("rec-1", originator="ATL", asset_id="dis:1:1:1"),
        _record("rec-2", originator="BDR"),
        _record("rec-3", originator="ATL", releasable=["BDR"]),
        _record("rec-4"),  # unlabelled
    ]

    async def fake_fetch(kind):
        assert kind == "records.v1"
        return records

    monkeypatch.setattr(pane_api, "_fetch_records_by_kind", fake_fetch)
    _patch_gate(monkeypatch, ["ATL", "BDR"], accepts=["records.v1"])

    result = pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    assert result["kind"] == "records.v1"
    assert result["admitted"] == 3
    assert result["refused"] == 1
    by_key = {r["key"]: r for r in result["records"]}
    assert by_key["rec-1"]["allowed"] is True
    assert by_key["rec-1"]["asset_id"] == "dis:1:1:1"
    assert by_key["rec-2"]["allowed"] is True
    assert by_key["rec-2"]["asset_id"] is None
    assert by_key["rec-3"]["allowed"] is True
    assert by_key["rec-4"]["allowed"] is False
    assert by_key["rec-4"]["reason"] == REASON_UNLABELLED
    assert by_key["rec-1"]["owning_tier"] == "edge-01"
    assert by_key["rec-1"]["decided_at"] == "2026-10-02T00:00:00+00:00"
    assert by_key["rec-1"]["body"] == {"asset_id": "dis:1:1:1"}


def test_destination_whose_accepts_lacks_kind_refuses_every_row(monkeypatch):
    """A destination entitled to the originator's nation still refuses every
    row of a kind it does not accept -- the kind check runs before the
    nation-overlap question is ever asked, exactly as gate.decide orders it."""
    records = [
        _record("rec-1", originator="ATL"),
        _record("rec-2", originator="BDR"),
    ]

    async def fake_fetch(kind):
        return records

    monkeypatch.setattr(pane_api, "_fetch_records_by_kind", fake_fetch)
    _patch_gate(monkeypatch, ["ATL", "BDR"], accepts=[])  # does not accept this kind

    result = pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    assert result["admitted"] == 0
    assert result["refused"] == 2
    for record in result["records"]:
        assert record["allowed"] is False
        assert record["reason"] == REASON_KIND_NOT_ACCEPTED


def test_no_kind_path_reads_asset_rows_unchanged(monkeypatch):
    """No `kind` -- exactly today's path. No `key`/`body`/`kind` field
    anywhere in the response; the asset fetch is the only one called."""
    calls = {"asset": 0, "kind": 0}

    async def fake_assets():
        calls["asset"] += 1
        return [_asset("dis:1:1:1000", originator="ATL")]

    async def fake_kind(kind):
        calls["kind"] += 1
        return []

    monkeypatch.setattr(pane_api, "_fetch_all_records", fake_assets)
    monkeypatch.setattr(pane_api, "_fetch_records_by_kind", fake_kind)
    _patch_gate(monkeypatch, ["ATL"])

    result = pane_api.build_decisions("system:c2-stand-in-atl")

    assert calls == {"asset": 1, "kind": 0}
    assert "kind" not in result
    assert result["records"][0]["asset_id"] == "dis:1:1:1000"
    assert "key" not in result["records"][0]
    assert "body" not in result["records"][0]


def test_unknown_destination_reads_asset_rows_same_as_today(monkeypatch):
    """A destination absent from the entitlements corpus still reads
    `asset_logistics_status` when no kind is requested -- unchanged from
    before `kind` existed. Whether it is ENTITLED to anything is a question
    for `EgressGate.decide` (`destination_unknown`), never for the fetch."""
    calls = {"asset": 0}

    async def fake_assets():
        calls["asset"] += 1
        return []

    monkeypatch.setattr(pane_api, "_fetch_all_records", fake_assets)
    _patch_gate(monkeypatch, [])

    pane_api.build_decisions("system:nobody-declared-this")

    assert calls["asset"] == 1


def test_atl_only_destination_refuses_a_bdr_originated_record():
    """Unit level, straight through `gate.decide` -- ADR-0046 s2's red-check
    restated for a generic record: a BDR-originated record, decided by a
    destination entitled to ATL only, is refused no_nation_overlap, not
    admitted."""
    gate = _gate("system:c2-stand-in-atl", ["ATL"])
    decision = gate.decide(
        {"originator_nation": "BDR", "releasable_to": []},
        key="rec-bdr",
    )

    assert decision.allowed is False
    assert decision.reason == REASON_NO_OVERLAP


def _refused(key: str, reason: str, *, provisional: bool = False) -> dict:
    return {"allowed": False, "reason": reason,
            "decision_id": f"intake-{key}", "provisional": provisional}


def _patch_fetch(monkeypatch, records):
    async def fake_fetch(kind):
        return records

    monkeypatch.setattr(pane_api, "_fetch_records_by_kind", fake_fetch)


def test_intake_refused_rows_are_listed_with_intakes_reason(monkeypatch):
    _patch_fetch(monkeypatch, [
        _record("rec-1", originator="ATL",
                intake=_refused("rec-1", "schema_invalid")),
        _record("rec-2", intake=_refused("rec-2", "unlabelled")),
        _record("rec-3", originator="ATL"),
    ])
    _patch_gate(monkeypatch, ["ATL"], accepts=["records.v1"])

    result = pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    assert result["admitted"] == 1
    assert result["refused"] == 2
    by_key = {r["key"]: r for r in result["records"]}
    assert by_key["rec-1"]["allowed"] is False
    assert by_key["rec-1"]["reason"] == "schema_invalid"
    assert by_key["rec-1"]["decision_id"] == "intake-rec-1"
    assert by_key["rec-1"]["refused_by"] == "intake"
    assert by_key["rec-2"]["allowed"] is False
    assert by_key["rec-2"]["reason"] == "unlabelled"
    assert by_key["rec-2"]["decision_id"] == "intake-rec-2"
    assert by_key["rec-2"]["refused_by"] == "intake"
    assert by_key["rec-3"]["allowed"] is True
    assert by_key["rec-3"]["refused_by"] is None
    assert by_key["rec-3"]["provisional"] is False


def test_gate_is_never_asked_about_an_intake_refused_row(monkeypatch):
    _patch_fetch(monkeypatch, [
        _record("rec-1", originator="ATL",
                intake=_refused("rec-1", "schema_invalid")),
        _record("rec-2", originator="ATL"),
    ])
    gate = _gate("system:records-dest-test", ["ATL"], kind="records.v1",
                 accepts=["records.v1"])
    seen = []
    real_decide = gate.decide

    def spy(label, *, key=None, **kw):
        seen.append(key)
        return real_decide(label, key=key, **kw)

    gate.decide = spy
    monkeypatch.setattr(
        pane_api.EgressGate, "for_destination",
        classmethod(lambda cls, destination, *, kind=None, **kw: gate),
    )

    pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    assert seen == ["rec-2"]


def test_provisional_intake_refusal_is_flagged(monkeypatch):
    _patch_fetch(monkeypatch, [
        _record("rec-1", originator="ATL",
                intake=_refused("rec-1", "unknown_answered_record",
                                provisional=True)),
    ])
    _patch_gate(monkeypatch, ["ATL"], accepts=["records.v1"])

    result = pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    rec = result["records"][0]
    assert rec["provisional"] is True
    assert rec["reason"] == "unknown_answered_record"
    assert rec["refused_by"] == "intake"


def test_gate_refusal_of_an_intake_admitted_row_is_attributed_to_gate(monkeypatch):
    _patch_fetch(monkeypatch, [_record("rec-1", originator="BDR")])
    _patch_gate(monkeypatch, ["ATL"], accepts=["records.v1"])

    result = pane_api.build_decisions("system:records-dest-test", kind="records.v1")

    rec = result["records"][0]
    assert rec["allowed"] is False
    assert rec["refused_by"] == "gate"
    assert rec["provisional"] is False
