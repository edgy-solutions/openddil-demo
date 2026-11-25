"""Unit tests for egress/kinds.py — ADR-0043.

Run: `python -m pytest egress/test_kinds.py -q` from openddil-demo/.

No network, no registry service: a kind is a `<Kind>.schema.json` file on
disk, and this module owns the jsonschema import so `gate.py` can stay
stdlib-only (see the Dockerfile comment on why that matters).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from kinds import load_declarations, load_kinds  # noqa: E402

# Neutral fixture name per the rule: `KindA`, not a real registry's kind.
KIND_A_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["asset_id"],
    "properties": {"asset_id": {"type": "string"}},
    # Ignored by validation — present to prove it is left alone, not stripped.
    "x-openddil": {"owner": "system:dest-a"},
}

# Not a valid Draft 2020-12 schema: "type" must be a recognised type name
# (or an array of them), and "not-a-type" is neither.
INVALID_SCHEMA = {"type": "not-a-type"}


def test_loading_a_dir_with_one_valid_and_one_invalid_schema_raises_naming_the_file(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_SCHEMA))
    (tmp_path / "KindB.schema.json").write_text(json.dumps(INVALID_SCHEMA))

    with pytest.raises(Exception) as exc:
        load_kinds(tmp_path)
    assert "KindB.schema.json" in str(exc.value)


def test_valid_and_invalid_instances_give_none_and_an_error(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_SCHEMA))

    validators = load_kinds(tmp_path)

    assert validators["KindA"]({"asset_id": "dis:1:1:1000"}) is None
    error = validators["KindA"]({})
    assert isinstance(error, str)
    assert error


# --- load_declarations -----------------------------------------------------

# Neutral fixture per the rule: pointers chosen to be distinct from each
# other so a test that reads the wrong one fails loudly.
KIND_A_DECLARED = dict(KIND_A_SCHEMA)
KIND_A_DECLARED["x-openddil"] = {
    "key": "/ref",
    "label": "/marking",
    "owning_tier": "/tier",
    "episode": {
        "asset": "/subject",
        "component": "/what/part",
        "fault_code": "/what/code",
    },
    "observed_at": "/what/seen_at",
    "sources": "/reports",
    "picture": "/context",
}


def test_load_declarations_reads_the_x_openddil_block(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_DECLARED))

    declarations = load_declarations(tmp_path)

    decl = declarations["KindA"]
    assert decl.key == "/ref"
    assert decl.label == "/marking"
    assert decl.owning_tier == "/tier"
    assert decl.episode.asset == "/subject"
    assert decl.episode.component == "/what/part"
    assert decl.episode.fault_code == "/what/code"
    assert decl.observed_at == "/what/seen_at"
    assert decl.sources == "/reports"
    assert decl.picture == "/context"


def test_load_declarations_missing_key_raises_naming_the_file(tmp_path):
    broken = dict(KIND_A_DECLARED)
    broken["x-openddil"] = {
        "label": "/marking",
        "owning_tier": "/tier",
        "episode": {
            "asset": "/subject",
            "component": "/what/part",
            "fault_code": "/what/code",
        },
    }
    (tmp_path / "KindA.schema.json").write_text(json.dumps(broken))

    with pytest.raises(Exception) as exc:
        load_declarations(tmp_path)
    assert "KindA.schema.json" in str(exc.value)


def test_a_schema_without_declarations_is_absent_not_an_error(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_DECLARED))
    bare = {k: v for k, v in KIND_A_SCHEMA.items() if k != "x-openddil"}
    (tmp_path / "KindB.schema.json").write_text(json.dumps(bare))

    declarations = load_declarations(tmp_path)

    assert set(declarations) == {"KindA"}


def test_key_and_label_alone_load_with_no_episode(tmp_path):
    only = {k: v for k, v in KIND_A_SCHEMA.items() if k != "x-openddil"}
    only["x-openddil"] = {"key": "/ref", "label": "/marking"}
    (tmp_path / "KindB.schema.json").write_text(json.dumps(only))

    decl = load_declarations(tmp_path)["KindB"]

    assert (decl.key, decl.label) == ("/ref", "/marking")
    assert decl.owning_tier is None and decl.episode is None


# --- provenance --------------------------------------------------------

def test_a_block_with_provenance_loads(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], provenance="/prov")
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    decl = load_declarations(tmp_path)["KindA"]

    assert decl.provenance == "/prov"


def test_a_schema_without_provenance_is_unchanged(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_DECLARED))

    decl = load_declarations(tmp_path)["KindA"]

    assert decl.provenance is None


def test_a_non_string_provenance_is_refused(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], provenance=123)
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    with pytest.raises(Exception) as exc:
        load_declarations(tmp_path)
    assert "KindA.schema.json" in str(exc.value)


# --- trigger (ADR-0046 §1: what opened the episode) -------------------------

def test_a_block_with_trigger_loads(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], trigger="/kind")
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    decl = load_declarations(tmp_path)["KindA"]

    assert decl.trigger == "/kind"


def test_a_schema_without_trigger_is_unchanged(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_DECLARED))

    decl = load_declarations(tmp_path)["KindA"]

    assert decl.trigger is None


def test_a_non_string_trigger_is_refused(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], trigger=123)
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    with pytest.raises(Exception) as exc:
        load_declarations(tmp_path)
    assert "KindA.schema.json" in str(exc.value)


# --- episode_id (the episode's own id, distinct from the event `key`) -------

def test_a_block_with_episode_id_loads(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], episode_id="/episode")
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    assert load_declarations(tmp_path)["KindA"].episode_id == "/episode"


def test_a_schema_without_episode_id_is_unchanged(tmp_path):
    (tmp_path / "KindA.schema.json").write_text(json.dumps(KIND_A_DECLARED))

    assert load_declarations(tmp_path)["KindA"].episode_id is None


def test_a_non_string_episode_id_is_refused(tmp_path):
    declared = dict(KIND_A_DECLARED)
    declared["x-openddil"] = dict(KIND_A_DECLARED["x-openddil"], episode_id=123)
    (tmp_path / "KindA.schema.json").write_text(json.dumps(declared))

    with pytest.raises(Exception) as exc:
        load_declarations(tmp_path)
    assert "KindA.schema.json" in str(exc.value)


# --- declared time formats (report mode by default) -------------------------

import logging  # noqa: E402

import jsonschema  # noqa: E402

from kinds import FORMAT_MODES, validator_for  # noqa: E402

TS_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["ts"],
    "properties": {"ts": {"type": "string", "format": "date-time"}},
}
SENTINEL = "SENTINEL-live-value"
BAD_TIMES = [
    "yesterday",
    "2026-02-30T00:00:00Z",
    "2026-11-24T25:00:00Z",
    "2026-11-24 10:00:00Z",
    "2026-11-24T10:00:00",
    "2026-11-24T10:00:00+24:00",
]


def _v(schema, mode=None, kind="KindT"):
    return validator_for(schema, kind=kind, format_mode=mode)


@pytest.mark.parametrize("ts", [
    "2026-11-24T10:00:00Z", "2026-11-24T10:00:00+02:30",
    "2026-11-24T10:00:00.123456Z", "2026-12-31T23:59:60Z",
])
def test_valid_date_time_passes_with_no_count(ts):
    v = _v(TS_SCHEMA, "report")
    assert v({"ts": ts}) is None
    assert v.format_failures == {}


@pytest.mark.parametrize("ts", BAD_TIMES)
def test_report_mode_leaves_result_counts_and_logs_without_value(ts, caplog):
    v = _v(TS_SCHEMA, "report")
    with caplog.at_level(logging.WARNING, logger="egress.kinds"):
        assert v({"ts": ts}) is None
    assert v.format_failures == {"date-time": 1}
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "kind=KindT path=$.ts format=date-time count=1" in caplog.text
    assert ts not in caplog.text


def test_sentinel_value_never_logged(caplog):
    v = _v(TS_SCHEMA, "report")
    with caplog.at_level(logging.DEBUG, logger="egress.kinds"):
        v({"ts": SENTINEL})
    assert v.format_failures == {"date-time": 1}
    assert SENTINEL not in caplog.text


def test_non_string_gets_no_format_count_and_structural_message_unchanged():
    v = _v(TS_SCHEMA, "report")
    plain = jsonschema.Draft202012Validator(TS_SCHEMA)
    rec = {"ts": 5}
    expect = next(iter(sorted(plain.iter_errors(rec), key=str))).message
    assert v(rec) == expect
    assert v.format_failures == {}
    loose = {"type": "object", "properties": {"ts": {"format": "date-time"}}}
    v2 = _v(loose, "report")
    assert v2({"ts": 5}) is None
    assert v2.format_failures == {}


def test_enforce_refuses_bad_and_passes_good():
    v = _v(TS_SCHEMA, "enforce")
    msg = v({"ts": "yesterday"})
    assert isinstance(msg, str) and msg
    assert v({"ts": "2026-11-24T10:00:00Z"}) is None


def test_off_mode_has_no_count():
    v = _v(TS_SCHEMA, "off")
    assert v({"ts": "yesterday"}) is None
    assert v.format_failures == {}


def test_unknown_mode_raises():
    assert FORMAT_MODES == ("off", "report", "enforce")
    with pytest.raises(ValueError) as exc:
        _v(TS_SCHEMA, "strict")
    assert "OPENDDIL_EGRESS_FORMAT_MODE" in str(exc.value)


def test_unknown_env_value_raises(monkeypatch):
    monkeypatch.setenv("OPENDDIL_EGRESS_FORMAT_MODE", "loud")
    with pytest.raises(ValueError) as exc:
        _v(TS_SCHEMA)
    assert "OPENDDIL_EGRESS_FORMAT_MODE" in str(exc.value)


def test_default_with_no_env_is_report(monkeypatch):
    monkeypatch.delenv("OPENDDIL_EGRESS_FORMAT_MODE", raising=False)
    v = _v(TS_SCHEMA)
    assert v({"ts": "yesterday"}) is None
    assert v.format_failures == {"date-time": 1}


def test_env_selects_enforce(monkeypatch):
    monkeypatch.setenv("OPENDDIL_EGRESS_FORMAT_MODE", "enforce")
    assert _v(TS_SCHEMA)({"ts": "yesterday"}) is not None


def test_nested_formats_are_checked():
    schema = {
        "type": "object",
        "properties": {
            "a": {"type": "array", "items": {"type": "string", "format": "date-time"}},
            "b": {"$ref": "#/$defs/T"},
        },
        "$defs": {"T": {"type": "string", "format": "date-time"}},
    }
    v = _v(schema, "report")
    assert v.checks_formats is True
    assert v({"a": ["2026-11-24T10:00:00Z", "nope"], "b": "bad"}) is None
    assert v.format_failures == {"date-time": 2}


def test_combinator_format_is_found():
    schema = {"anyOf": [{"type": "string", "format": "date"}, {"type": "null"}]}
    assert _v(schema, "report").checks_formats is True


@pytest.mark.parametrize("fmt,good,bad", [
    ("date", "2026-11-24", "2026-02-30"),
    ("time", "10:00:00Z", "10:00:00"),
])
def test_date_and_time_formats(fmt, good, bad):
    schema = {"type": "string", "format": fmt}
    v = _v(schema, "enforce")
    assert v(good) is None
    assert v(bad) is not None


def test_schema_without_time_format_builds_no_second_validator():
    v = _v({"type": "string", "format": "email"}, "report")
    assert v.checks_formats is False
    assert v("not-an-email") is None
    assert v.format_failures == {}


def test_warning_cadence_is_1_10_100(caplog):
    v = _v(TS_SCHEMA, "report")
    with caplog.at_level(logging.WARNING, logger="egress.kinds"):
        for _ in range(12):
            v({"ts": "yesterday"})
    assert v.format_failures == {"date-time": 12}
    counts = [r.getMessage().rsplit("count=", 1)[1] for r in caplog.records]
    assert counts == ["1", "10"]


def test_structural_message_byte_identical_to_plain_validator():
    schema = {
        "type": "object", "required": ["ts", "n"],
        "properties": {"ts": {"type": "string", "format": "date-time"},
                       "n": {"type": "integer"}},
    }
    plain = jsonschema.Draft202012Validator(schema)
    for mode in ("off", "report"):
        v = _v(schema, mode)
        for rec in ({}, {"ts": 1, "n": "x"}, {"ts": "yesterday", "n": "x"},
                    {"ts": "yesterday", "n": 1}):
            err = next(iter(sorted(plain.iter_errors(rec), key=str)), None)
            assert v(rec) == (None if err is None else err.message)


def test_load_kinds_passes_kind_name_and_testdata_loads(tmp_path):
    (tmp_path / "KindT.schema.json").write_text(json.dumps(TS_SCHEMA))
    v = load_kinds(tmp_path, format_mode="report")["KindT"]
    assert v.kind == "KindT"
    assert load_kinds(Path(__file__).parent / "testdata")
