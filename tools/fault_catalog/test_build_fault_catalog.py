import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
BUILD_SCRIPT = HERE / "build_fault_catalog.py"
FIXTURE_DIR = HERE.parent.parent / "tests" / "fixtures" / "s1000d-array-module"
MAP_EXAMPLE = HERE / "map.example.yaml"
EXPECTED_JSON = FIXTURE_DIR / "fault-catalog.expected.json"


def _run(args):
    return subprocess.run(
        [sys.executable, str(BUILD_SCRIPT), *args],
        capture_output=True, text=True,
    )


def test_golden_catalog_matches_the_fixture():
    """The catalog regenerated from the public fixture manual matches the
    checked-in golden file byte-for-byte (after JSON parse, since
    whitespace is not the contract)."""
    result = _run(["--manual-dir", str(FIXTURE_DIR), "--map", str(MAP_EXAMPLE)])
    assert result.returncode == 0, result.stderr
    actual = json.loads(result.stdout)
    expected = json.loads(EXPECTED_JSON.read_text(encoding="utf-8"))
    assert actual == expected


def test_golden_catalog_is_exactly_one_code():
    result = _run(["--manual-dir", str(FIXTURE_DIR), "--map", str(MAP_EXAMPLE)])
    assert result.returncode == 0, result.stderr
    catalog = json.loads(result.stdout)
    codes = catalog["variants"]["MRAD_Sensor"]["codes"]
    assert len(codes) == 1
    assert codes[0]["code"] == "MRAD-ARR-0417"
    assert codes[0]["component"] == "tr_module"
    assert codes[0]["text"] == "Array module fault, section 3."


def test_unmapped_assembly_exits_1(tmp_path):
    """A fault code whose assembly has no MAP.yaml entry is an error, named
    on stderr -- never a silent default."""
    empty_map = tmp_path / "empty-map.yaml"
    empty_map.write_text(
        textwrap.dedent(
            """
            MRAD_Sensor:
              manual: ODMRAD
              assemblies: {}
            """
        ),
        encoding="utf-8",
    )
    result = _run(["--manual-dir", str(FIXTURE_DIR), "--map", str(empty_map)])
    assert result.returncode == 1
    assert "34-10-01" in result.stderr
    assert "MRAD-ARR-0417" in result.stderr


def test_unmapped_manual_exits_1(tmp_path):
    """A fault code from a manual no variant declares is also an error."""
    other_map = tmp_path / "other-map.yaml"
    other_map.write_text(
        textwrap.dedent(
            """
            SOME_OTHER_VARIANT:
              manual: NOT-ODMRAD
              assemblies: {}
            """
        ),
        encoding="utf-8",
    )
    result = _run(["--manual-dir", str(FIXTURE_DIR), "--map", str(other_map)])
    assert result.returncode == 1
    assert "ODMRAD" in result.stderr
