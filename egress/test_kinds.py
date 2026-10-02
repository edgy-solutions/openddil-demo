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

from kinds import load_kinds  # noqa: E402

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
