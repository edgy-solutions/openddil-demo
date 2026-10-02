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
