#!/usr/bin/env python3
"""check_corpus_version.py <yaml> <versions-file>

A corpus file (`policy/users.yaml`, `policy/users-promoted.yaml`) carries a
`version:` line. This script is the check that the version actually moved
when the content did, and that the versions file next to it -- an
append-only log of every released `(version, hash)` pair -- was kept in
sync rather than drifting out from under the corpus it describes.

WHAT IT CHECKS, IN ORDER
  (a) the corpus file's current `(version, hash)` must be the LAST line of
      the versions file. If it is not, one of two things happened, and the
      message says which:
        - same version as the last line, different hash: the content
          changed and the version was never bumped.
        - different version, different hash: the version was bumped (and
          the content changed with it) but no line was appended for it.
  (b) no version may appear on more than one line of the versions file. A
      version that appears twice means the content changed under a version
      number that was supposed to be fixed forever -- the versions file
      exists to make that impossible to do silently.
  (c) an exception to (a): when the hash is UNCHANGED from the last line but
      the version differs, the corpus was re-released with no content
      change at all. That is allowed -- a version bump costs nothing when
      nothing moved -- but it is unusual enough to warn about rather than
      pass silently.

THE HASH is sha256 over the file's bytes with its `version:` line (and only
that line) removed, so a version bump by itself never changes the hash --
only the content around it can.

Exit 0 on success (including the (c) warning case), 1 otherwise. Every
failure prints the reason to stderr before exiting.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

_VERSION_LINE_RE = re.compile(r"^version:\s*(\S+)\s*$")


class CorpusVersionError(ValueError):
    """The corpus file or the versions file is malformed in a way that
    makes the check impossible to run, as opposed to a check that ran and
    found a mismatch."""


def corpus_version_and_hash(yaml_path: Path) -> tuple[str, str]:
    """Return (version, hash) for one corpus file.

    `hash` is sha256 hex of the file's bytes with its `version:` line
    removed -- the one line a release is expected to touch on its own.
    """
    data = yaml_path.read_bytes()
    lines = data.splitlines(keepends=True)
    version: str | None = None
    kept: list[bytes] = []
    for line in lines:
        text = line.decode("utf-8", "replace")
        stripped = text.rstrip("\r\n")
        match = _VERSION_LINE_RE.match(stripped)
        if match is not None:
            if version is not None:
                raise CorpusVersionError(
                    f"{yaml_path}: more than one top-level 'version:' line")
            version = match.group(1)
            continue
        kept.append(line)
    if version is None:
        raise CorpusVersionError(f"{yaml_path}: no top-level 'version:' line found")
    digest = hashlib.sha256(b"".join(kept)).hexdigest()
    return version, digest


def parse_versions_file(versions_path: Path) -> list[tuple[str, str]]:
    """Return the versions file's lines as (version, hash) tuples, in file
    order. Raises CorpusVersionError on a malformed line."""
    if not versions_path.exists():
        return []
    entries: list[tuple[str, str]] = []
    for lineno, raw in enumerate(versions_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2:
            raise CorpusVersionError(
                f"{versions_path}:{lineno}: expected '<version> <hash>', got {raw!r}")
        entries.append((parts[0], parts[1]))
    return entries


def check(yaml_path: Path, versions_path: Path) -> list[str]:
    """Return a list of failure reasons (empty means the check passed).

    Warnings (case (c)) are printed directly rather than returned, since
    they do not fail the check."""
    version, digest = corpus_version_and_hash(yaml_path)
    entries = parse_versions_file(versions_path)

    seen: dict[str, str] = {}
    failures: list[str] = []
    for lineno, (v, h) in enumerate(entries, start=1):
        if v in seen:
            failures.append(
                f"{versions_path}: version {v!r} appears on more than one line "
                f"(line {lineno} and an earlier line) -- content changed under "
                f"a version that was supposed to be fixed")
        seen[v] = h
    if failures:
        return failures

    if not entries:
        return [f"{versions_path}: no entries; expected a last line for "
                f"{yaml_path} version {version!r} (hash {digest})"]

    last_version, last_hash = entries[-1]

    if version == last_version and digest == last_hash:
        return []  # exactly the last line -- nothing changed, nothing to say

    if version == last_version and digest != last_hash:
        return [f"{yaml_path}: content changed under version {version!r} with "
                f"no version bump (hash is {digest}, versions file has "
                f"{last_hash} for this version)"]

    if version != last_version and digest == last_hash:
        print(f"WARNING: {yaml_path}: version bumped from {last_version!r} to "
              f"{version!r} with no content change (hash unchanged)",
              file=sys.stderr)
        return []

    # version != last_version and digest != last_hash
    return [f"{yaml_path}: current (version={version!r}, hash={digest}) is not "
            f"the last line of {versions_path} (last line is "
            f"({last_version!r}, {last_hash})) -- append a new line for this "
            f"release"]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} <yaml> <versions-file>", file=sys.stderr)
        return 1
    yaml_path = Path(argv[1])
    versions_path = Path(argv[2])
    try:
        failures = check(yaml_path, versions_path)
    except CorpusVersionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    for failure in failures:
        print(f"ERROR: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
