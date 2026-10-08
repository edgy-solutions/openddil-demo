"""Tests for the periodic PDP refresh: main.refresh_gates and intake.refresh_versions.

No Kafka and no PDP: `gate.ask_topaz` (and intake's imported name) are
monkeypatched with scripted answers.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import gate as gate_mod  # noqa: E402
import intake  # noqa: E402
import main as main_mod  # noqa: E402
from gate import AuthzUnavailable  # noqa: E402
from routes import Route  # noqa: E402

R1 = Route(name="r1", source_topic="s1", destination="dest-1", sink_topic="k1")
R2 = Route(name="r2", source_topic="s2", destination="dest-2", sink_topic="k2")


def _answer(nations=("US",), known=True, policy="p1", corpus="c1", registry="v1"):
    return {
        "allow": True, "allowed_nations": list(nations), "policy_version": policy,
        "corpus_version": corpus, "role": "observer", "subject_known": known,
        "accepts": [], "registry_version": registry, "trust_on_behalf_of": False,
    }


def _script(monkeypatch, fn):
    monkeypatch.setattr(gate_mod, "ask_topaz", fn)


def _initial(monkeypatch, answers):
    _script(monkeypatch, lambda subject: answers[subject])
    return main_mod._build_gates([R1, R2], {}, {})


def _lines(caplog, word):
    return [r for r in caplog.records if word in r.getMessage()]


def test_unchanged_answer_keeps_same_gate_objects(monkeypatch, caplog):
    answers = {"dest-1": _answer(), "dest-2": _answer()}
    gates = _initial(monkeypatch, answers)
    caplog.set_level(logging.INFO, logger="egress")
    out = main_mod.refresh_gates([R1, R2], gates, {}, {}, sleep=lambda s: None)
    assert out[R1] is gates[R1] and out[R2] is gates[R2]
    assert not _lines(caplog, "GATE_RELOAD")


def test_registry_change_replaces_only_that_route_and_carries_counts(monkeypatch, caplog):
    answers = {"dest-1": _answer(known=False), "dest-2": _answer()}
    gates = _initial(monkeypatch, answers)
    gates[R1].counts["admit"] = 3
    answers["dest-1"] = _answer(known=True, registry="v2")
    caplog.set_level(logging.INFO, logger="egress")
    out = main_mod.refresh_gates([R1, R2], gates, {}, {}, sleep=lambda s: None)
    assert out[R1] is not gates[R1]
    assert out[R1].registry_version == "v2" and out[R1].destination_known is True
    assert out[R1].counts is gates[R1].counts and out[R1].counts == {"admit": 3}
    assert out[R2] is gates[R2]
    reloads = [r for r in _lines(caplog, "GATE_RELOAD") if "UNVERSIONED" not in r.getMessage()]
    assert len(reloads) == 1
    msg = reloads[0].getMessage()
    assert "registry=v1->v2" in msg and "known=False->True" in msg
    assert not _lines(caplog, "GATE_RELOAD_UNVERSIONED")


def test_nations_change_under_same_versions_is_flagged_unversioned(monkeypatch, caplog):
    answers = {"dest-1": _answer(nations=("US",)), "dest-2": _answer()}
    gates = _initial(monkeypatch, answers)
    answers["dest-1"] = _answer(nations=("US", "GB"))
    caplog.set_level(logging.INFO, logger="egress")
    out = main_mod.refresh_gates([R1, R2], gates, {}, {}, sleep=lambda s: None)
    assert out[R1] is not gates[R1] and out[R1].nations == ("GB", "US")
    assert len(_lines(caplog, "GATE_RELOAD route=")) == 1
    assert len(_lines(caplog, "GATE_RELOAD_UNVERSIONED")) == 1


def test_failed_attempt_replaces_nothing_then_retries_whole_set(monkeypatch, caplog):
    answers = {"dest-1": _answer(), "dest-2": _answer()}
    gates = _initial(monkeypatch, answers)
    calls: list[str] = []
    state = {"attempt": 0}

    def ask(subject):
        calls.append(subject)
        if subject == "dest-1":
            state["attempt"] += 1
        # First attempt: dest-1 answers with NEW data, dest-2 fails.
        if state["attempt"] == 1:
            if subject == "dest-2":
                raise AuthzUnavailable("down")
            return _answer(registry="first")
        return _answer(registry="second")

    _script(monkeypatch, ask)
    sleeps: list[float] = []
    caplog.set_level(logging.INFO, logger="egress")
    out = main_mod.refresh_gates(
        [R1, R2], gates, {}, {}, sleep=sleeps.append, retry_delays=(0.5, 0.5))
    assert len(_lines(caplog, "REFRESH_WAITING")) == 1
    assert sleeps == [0.5]
    # Both routes come from the second attempt only; nothing from the first.
    assert out[R1].registry_version == "second" and out[R2].registry_version == "second"
    assert calls == ["dest-1", "dest-2", "dest-1", "dest-2"]


def test_every_attempt_failing_raises_after_all_delays(monkeypatch):
    answers = {"dest-1": _answer(), "dest-2": _answer()}
    gates = _initial(monkeypatch, answers)

    def down(subject):
        raise AuthzUnavailable("down")

    _script(monkeypatch, down)
    sleeps: list[float] = []
    delays = (0.1, 0.2, 0.3)
    with pytest.raises(AuthzUnavailable):
        main_mod.refresh_gates(
            [R1, R2], gates, {}, {}, sleep=sleeps.append, retry_delays=delays)
    assert len(sleeps) == len(delays)


def test_intake_refresh_versions_logs_change_and_returns_new(monkeypatch, caplog):
    monkeypatch.setattr(intake, "ask_topaz", lambda s: _answer(policy="p2"))
    held = {"policy_version": "p1", "corpus_version": "c1", "registry_version": "v1"}
    caplog.set_level(logging.INFO, logger="egress")
    out = intake.refresh_versions("e1", "src", held)
    assert out == {"policy_version": "p2", "corpus_version": "c1", "registry_version": "v1"}
    assert len(_lines(caplog, "REGISTRY_VERSIONS_CHANGED entry=e1")) == 1
    caplog.clear()
    assert intake.refresh_versions("e1", "src", out) == out
    assert not _lines(caplog, "REGISTRY_VERSIONS_CHANGED")


def test_intake_refresh_versions_keeps_held_when_pdp_down(monkeypatch, caplog):
    def down(subject):
        raise AuthzUnavailable("down")

    monkeypatch.setattr(intake, "ask_topaz", down)
    held = {"policy_version": "p1", "corpus_version": "c1", "registry_version": "v1"}
    caplog.set_level(logging.INFO, logger="egress")
    assert intake.refresh_versions("e1", "src", held) is held
    assert len(_lines(caplog, "REGISTRY_VERSIONS refresh failed for entry=e1")) == 1
