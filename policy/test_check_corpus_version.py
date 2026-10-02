"""Tests for check_corpus_version.py -- the gate on a corpus file's
`version:` line actually moving when its content does.

Run: `py -3 -m pytest -q policy/test_check_corpus_version.py` from
openddil-demo/ (or `py -3 -m pytest -q` from policy/).

Each red case below is run first against the broken fixture to see it fail
for the reason this script claims, then the real repo files are checked and
must pass -- the versions files committed alongside users.yaml and
users-promoted.yaml are seeded from the SAME function this test imports, so
drift between the seed and the checker itself cannot hide a bug.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_corpus_version import check, corpus_version_and_hash  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent


def _write_yaml(path: Path, version: str, body: str) -> None:
    path.write_text(f"version: {version}\n{body}", encoding="utf-8")


def test_content_changed_without_version_bump_fails(tmp_path: pytest.TempPathFactory):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"
    _write_yaml(yaml_path, "v1", "users:\n  a: 1\n")
    _, digest = corpus_version_and_hash(yaml_path)
    versions_path.write_text(f"v1 {digest}\n", encoding="utf-8")

    # Content changes; version does not.
    _write_yaml(yaml_path, "v1", "users:\n  a: 2\n")

    failures = check(yaml_path, versions_path)
    assert failures, "expected a failure when content changes under a fixed version"
    assert "no version bump" in failures[0]


def test_version_bumped_but_versions_file_not_appended_fails(tmp_path):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"
    _write_yaml(yaml_path, "v1", "users:\n  a: 1\n")
    _, digest = corpus_version_and_hash(yaml_path)
    versions_path.write_text(f"v1 {digest}\n", encoding="utf-8")

    # Version AND content change, but the versions file is left behind.
    _write_yaml(yaml_path, "v2", "users:\n  a: 2\n")

    failures = check(yaml_path, versions_path)
    assert failures, "expected a failure when the versions file has no line for the new release"
    assert "is not the last line" in failures[0]


def test_same_version_on_two_lines_fails(tmp_path):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"
    _write_yaml(yaml_path, "v2", "users:\n  a: 2\n")
    _, digest = corpus_version_and_hash(yaml_path)
    # v1 appears twice, with two different hashes -- content changed under a
    # version number that was supposed to be fixed.
    versions_path.write_text(f"v1 aaaa\nv1 bbbb\nv2 {digest}\n", encoding="utf-8")

    failures = check(yaml_path, versions_path)
    assert failures, "expected a failure when a version repeats in the versions file"
    assert "more than one line" in failures[0]


def test_version_bumped_with_no_content_change_warns_but_passes(tmp_path, capsys):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"
    _write_yaml(yaml_path, "v1", "users:\n  a: 1\n")
    _, digest = corpus_version_and_hash(yaml_path)
    versions_path.write_text(f"v1 {digest}\n", encoding="utf-8")

    # Version bumped; body untouched -- the hash is therefore unchanged.
    _write_yaml(yaml_path, "v2", "users:\n  a: 1\n")

    failures = check(yaml_path, versions_path)
    assert failures == []
    assert "WARNING" in capsys.readouterr().err


def test_versions_file_missing_an_entry_entirely_fails(tmp_path):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"  # never created
    _write_yaml(yaml_path, "v1", "users:\n  a: 1\n")

    failures = check(yaml_path, versions_path)
    assert failures, "an empty/missing versions file must not pass"


def test_matching_last_line_passes_cleanly(tmp_path, capsys):
    yaml_path = tmp_path / "corpus.yaml"
    versions_path = tmp_path / "corpus.versions"
    _write_yaml(yaml_path, "v1", "users:\n  a: 1\n")
    _, digest = corpus_version_and_hash(yaml_path)
    versions_path.write_text(f"v1 {digest}\n", encoding="utf-8")

    failures = check(yaml_path, versions_path)
    assert failures == []
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("yaml_name,versions_name", [
    ("users.yaml", "users.versions"),
    ("users-promoted.yaml", "users-promoted.versions"),
])
def test_real_repo_files_pass(yaml_name, versions_name):
    yaml_path = REPO_ROOT / "policy" / yaml_name
    versions_path = REPO_ROOT / "policy" / versions_name
    failures = check(yaml_path, versions_path)
    assert failures == []
