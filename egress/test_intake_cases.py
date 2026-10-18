"""Unit tests for egress/intake.py's per-case poll mode (`poll.case_url_template`).

Run: `python -m pytest egress/test_intake_cases.py -q` from openddil-demo/.

Synthetic ids only. No HTTP, no broker, no Postgres: `fetch_case`, the store
and the gate are injected, the same seam test_intake.py uses for the list
mode. The artifact is an ActionRecord in the week-1 contract shape.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from gate import Label  # noqa: E402
import intake  # noqa: E402
from intake import (  # noqa: E402
    REASON_LABEL_MISMATCH,
    AnsweredMap,
    AnswersSpec,
    ApproversSpec,
    CaseRow,
    IntakeConfigError,
    IntakeEntry,
    PollSpec,
    load_intake_config,
    run_poll,
)
from kinds import Declarations, validator_for  # noqa: E402
from test_intake import RECORD_DECL, QUOTE_DECL, _FakeStore, resolved_gate  # noqa: E402

NOW = datetime(2026, 10, 17, 12, 0, 0, tzinfo=timezone.utc)
TEMPLATE = "https://gateway.invalid/cases/{case_id}/action"

ACTION_DECL = Declarations(key="/action_id", label="/label", owning_tier="/owning_tier")
ACTION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["action_id", "event_id", "label"],
}
VALIDATE_ACTION = validator_for(ACTION_SCHEMA)


def make_entry(**poll_over) -> IntakeEntry:
    poll = dict(url=None, interval_s=30.0, items_pointer="", case_url_template=TEMPLATE,
                cases_from_route="route-x")
    poll.update(poll_over)
    return IntakeEntry(
        name="actions", source_destination="system:relay-a", kind="ActionRecord",
        poll=PollSpec(**poll),
        answers=AnswersSpec(topic="answers-topic", kind="KindR",
                            ref_pointer="/event_id", id_pointer="/ident"),
        approvers=ApproversSpec(array_pointer="/approval_chain", subject_field="approver_sub"),
        onward_topic="release-requests",
    )


def action_record(n: int = 1, **over) -> dict:
    base = {
        "action_id": f"act-{n}",
        "event_id": f"ep-{n}",
        "asset_id": "asset-a",
        "owning_tier": "edge-07",
        "label": {"originator_nation": "ATL", "releasable_to": ["ATL", "BRV"]},
        "work_order": {"task": "replace comp-1", "task_refs": ["F-1"], "parts": [], "outcome": "done"},
        "approval_chain": [
            {"step": 1, "role": "chooser", "approver_sub": "sub-chooser", "decision": "approve",
             "decided_at": "2026-10-17T10:00:00Z", "decision_record_ref": "dr-1"},
            {"step": 2, "role": "approver", "approver_sub": "sub-approver", "decision": "approve",
             "decided_at": "2026-10-17T10:05:00Z", "decision_record_ref": "dr-2"},
            {"step": 3, "role": "releaser", "approver_sub": "sub-releaser", "decision": "release",
             "decided_at": "2026-10-17T10:10:00Z", "decision_record_ref": "dr-3"},
        ],
        "provenance": {"produced_by": "system:relay-a"},
    }
    base.update(over)
    return base


class _CaseStore(_FakeStore):
    """The list-mode fake plus `open_cases`, mirroring the real SQL: ledger
    rows inside the window, each with the stored decisions whose
    `answered_id` is its case_id, episode_id or event_id."""

    def __init__(self, ledger):
        super().__init__()
        self.ledger = list(ledger)  # (case_id, episode_id, event_id, first_recorded_at)
        self.seeded: list[dict] = []

    async def open_cases(self, route, kind, *, since):
        out = []
        for case_id, episode_id, event_id, first in self.ledger:
            if first < since:
                continue
            ids = {case_id, episode_id, event_id}
            decisions = [r.decision for r in self.existing.values()
                         if r.decision.get("answered_id") in ids]
            decisions += [d for d in self.seeded if d.get("answered_id") in ids]
            out.append(CaseRow(case_id=case_id, first_recorded_at=first, decisions=tuple(decisions)))
        return out


@pytest.fixture(autouse=True)
def _fresh_case_cursors():
    intake._CASE_CURSORS.clear()
    yield
    intake._CASE_CURSORS.clear()


def ledger_row(n: int, age_s: float = 60.0):
    return (f"case-{n}", f"ep-{n}", f"ev-{n}", NOW - timedelta(seconds=age_s))


def answered_for(*ns: int) -> AnsweredMap:
    answered = AnsweredMap()
    for n in ns:
        answered.put(f"ep-{n}", Label(originator_nation="ATL", releasable_to=("ATL", "BRV")))
    answered.caught_up = True
    return answered


class _Fetch:
    """Scripted per-URL responses; the last one repeats. Records the URLs."""

    def __init__(self, script):
        self.script = {k: list(v) for k, v in script.items()}
        self.urls: list[str] = []

    def __call__(self, url, token=None):
        self.urls.append(url)
        seq = self.script.get(url, [(404, None)])
        return seq.pop(0) if len(seq) > 1 else seq[0]


def run(entry, store, fetch, answered, counters, produced=None):
    produced = produced if produced is not None else []
    asyncio.run(run_poll(
        entry, ACTION_DECL, VALIDATE_ACTION,
        fetch=lambda *a, **k: pytest.fail("list fetch must not be used"),
        fetch_case=fetch, store=store, answered=answered,
        gate_for=lambda subject: resolved_gate(),
        produce=lambda *a: produced.append(a), counters=counters, now=NOW,
    ))
    return produced


def url_for(n: int) -> str:
    return TEMPLATE.replace("{case_id}", f"case-{n}")


def test_404_then_200_is_admitted_on_the_second_tick_only():
    entry = make_entry()
    store = _CaseStore([ledger_row(1)])
    fetch = _Fetch({url_for(1): [(404, None), (200, action_record(1))]})
    counters: dict[str, int] = {}
    answered = answered_for(1)

    produced = run(entry, store, fetch, answered, counters)
    assert store.upserts == [] and produced == []
    assert counters.get("case_no_action") == 1
    assert "case_fetch_failed" not in counters

    produced = run(entry, store, fetch, answered, counters)
    assert len(produced) == 1
    [row] = store.upserts
    assert row["kind"] == "ActionRecord" and row["key"] == "act-1"
    assert row["decision"]["allowed"] is True
    assert row["decision"]["answered_id"] == "ep-1"
    assert counters["admitted"] == 1
    assert counters["case_no_action"] == 1

    # Third tick: the admitted row is final, so the case is not fetched again.
    fetch.urls.clear()
    run(entry, store, fetch, answered, counters)
    assert fetch.urls == []


def test_label_mismatch_is_refused_as_on_the_list_path():
    entry = make_entry()
    store = _CaseStore([ledger_row(1)])
    wrong = action_record(1, label={"originator_nation": "BDR", "releasable_to": ["BDR"]})
    fetch = _Fetch({url_for(1): [(200, wrong)]})
    counters: dict[str, int] = {}
    produced = run(entry, store, fetch, answered_for(1), counters)
    assert produced == []
    [row] = store.upserts
    assert row["decision"]["allowed"] is False
    assert row["decision"]["reason"] == REASON_LABEL_MISMATCH
    assert counters[f"refused:{REASON_LABEL_MISMATCH}"] == 1


def test_case_past_the_window_is_never_fetched():
    entry = make_entry(case_window_s=3600.0)
    store = _CaseStore([ledger_row(1, age_s=7200), ledger_row(2, age_s=60)])
    fetch = _Fetch({})
    run(entry, store, fetch, answered_for(1, 2), {})
    assert fetch.urls == [url_for(2)]


def test_cap_fetches_oldest_first_and_counts_the_rest_deferred():
    entry = make_entry(max_cases_per_tick=50)
    # case-1 is the oldest; case-60 the newest.
    store = _CaseStore([ledger_row(n, age_s=10_000 - n) for n in range(1, 61)])
    fetch = _Fetch({})
    counters: dict[str, int] = {}
    run(entry, store, fetch, answered_for(), counters)
    assert fetch.urls == [url_for(n) for n in range(1, 51)]
    assert counters["cases_deferred"] == 10
    assert counters["case_no_action"] == 50


def test_cap_walks_the_whole_open_set_across_ticks():
    # 60 open cases, cap 50: tick 2 fetches the 10 tick 1 deferred, then wraps
    # to the oldest. An oldest-first cap would refetch 1..50 forever.
    entry = make_entry(max_cases_per_tick=50)
    store = _CaseStore([ledger_row(n, age_s=10_000 - n) for n in range(1, 61)])
    fetch = _Fetch({})
    run(entry, store, fetch, answered_for(), {})
    fetch.urls.clear()
    counters: dict[str, int] = {}
    run(entry, store, fetch, answered_for(), counters)
    assert fetch.urls == [url_for(n) for n in list(range(51, 61)) + list(range(1, 41))]
    assert counters["cases_deferred"] == 10


def test_case_with_a_final_intake_row_is_not_fetched_again():
    entry = make_entry()
    store = _CaseStore([ledger_row(1), ledger_row(2), ledger_row(3)])
    # case-1: refused, non-provisional (final). case-2: provisional (still open).
    store.seeded.append({"answered_id": "ep-1", "allowed": False,
                         "reason": REASON_LABEL_MISMATCH, "provisional": False})
    store.seeded.append({"answered_id": "ep-2", "allowed": False,
                         "reason": "answered_record_unknown", "provisional": True})
    fetch = _Fetch({})
    run(entry, store, fetch, answered_for(), {})
    assert fetch.urls == [url_for(2), url_for(3)]


def test_other_statuses_and_network_errors_warn_once_per_tick(caplog):
    entry = make_entry()
    store = _CaseStore([ledger_row(1), ledger_row(2), ledger_row(3)])

    def fetch(url, token=None):
        if url == url_for(1):
            return 503, None
        if url == url_for(2):
            raise OSError("connection refused")
        return 404, None

    counters: dict[str, int] = {}
    with caplog.at_level("WARNING"):
        run(entry, store, fetch, answered_for(), counters)
    assert counters["case_fetch_failed"] == 2
    assert counters["case_no_action"] == 1
    assert len([r for r in caplog.records if r.levelname == "WARNING"]) == 1
    assert store.upserts == []


def test_case_id_is_url_encoded():
    entry = make_entry()
    store = _CaseStore([("case/with space", "ep-1", "ev-1", NOW)])
    fetch = _Fetch({})
    run(entry, store, fetch, answered_for(), {})
    assert fetch.urls == ["https://gateway.invalid/cases/case%2Fwith%20space/action"]


# --- config -----------------------------------------------------------------

def _config(tmp_path, poll: dict) -> str:
    path = tmp_path / "intake.json"
    path.write_text(json.dumps([{
        "name": "n1", "source_destination": "system:relay-a", "kind": "KindQ",
        "poll": poll,
        "answers": {"topic": "t", "kind": "KindR", "ref_pointer": "/a", "id_pointer": "/b"},
        "approvers": {"array_pointer": "/e", "subject_field": "subject"},
        "onward_topic": "o",
    }]), encoding="utf-8")
    return str(path)


DECLS = {"KindQ": QUOTE_DECL, "KindR": RECORD_DECL}
BASE = {"interval_s": 30, "items_pointer": ""}


def test_config_case_mode_parses_with_defaults(tmp_path):
    [entry] = load_intake_config(_config(tmp_path, {
        **BASE, "case_url_template": TEMPLATE, "cases_from_route": "route-x"}), DECLS)
    assert entry.poll.url is None
    assert entry.poll.case_url_template == TEMPLATE
    assert entry.poll.cases_from_route == "route-x"
    assert entry.poll.case_window_s == 86400.0
    assert entry.poll.max_cases_per_tick == 50


@pytest.mark.parametrize("poll,match", [
    ({**BASE, "url": "http://x", "case_url_template": TEMPLATE, "cases_from_route": "r"}, "not both"),
    ({**BASE}, "neither is set"),
    ({**BASE, "case_url_template": "https://gw.invalid/cases/action", "cases_from_route": "r"},
     r"\{case_id\}"),
    ({**BASE, "case_url_template": TEMPLATE}, "cases_from_route"),
])
def test_config_refuses_bad_poll_modes(tmp_path, poll, match):
    with pytest.raises(IntakeConfigError, match=match):
        load_intake_config(_config(tmp_path, poll), DECLS)
