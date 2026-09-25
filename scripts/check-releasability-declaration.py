#!/usr/bin/env python3
"""Refuse to start when the releasability declaration names no assets.

WHY THIS EXISTS
Compose proved the releasability code path against a fleet of nobody from
the day the stack existed, and every run passed. The declaration was absent
from the assembled `/ontology`, the ingress mapping's `file()` read nothing,
and every record went out unlabelled -- which is a LEGAL ANSWER. Deny-
unlabeled is the floor ADR-0029 asks for, so a stack labelling nothing looks
exactly like a stack correctly refusing an undeclared fleet. There was no
error to see.

So the zero gets a mechanism. A declaration that resolves to zero assets is
not a quiet floor, it is a **failure to start** -- the same shape as the
pinned entity map refusing an id it does not carry, rather than substituting
a default and continuing.

WHAT IT REFUSES, AND WHY EACH ONE IS NOT THE SAME FACT
  missing      the file is not there at all -- assembly did not happen, or
               was assembled from the wrong source
  empty        zero bytes. This is the defect that was actually made, by a
               nested single-file bind mount into a writable parent, which
               "succeeds" by creating one. It parses as a fleet of no
               assets, which is why it is the red check
  unparseable  present and not YAML
  not a map    parses to a scalar or a list; `assets` cannot exist
  no assets    parses fine, `assets` is absent or empty. The file was
               authored and declares nobody

The last one is the point. The first four are accidents a reader would
eventually notice; "parses fine, declares nobody" is the one that runs green
for months.

WHAT IT DOES NOT DO
It does not validate nation codes, cross-check `releasable_to` against
`nations`, or say anything about whether a declaration is CORRECT. The
readers do that and raise on what they find -- see
`openddil-logistics-sim/src/logistics_sim/releasability.py`. This is the
floor check only: SOMETHING was declared. A check that grew into a second
validator would be a second implementation of the declaration's rules.

Usage:
    python scripts/check-releasability-declaration.py [PATH]

PATH defaults to /ontology/releasability.yaml, which is where the assembled
overlay puts it inside a container. Exit 0 = at least one asset declared.
Exit 1 = refused, with the reason and what was seen.
"""
from __future__ import annotations

import sys
from pathlib import Path

DEFAULT_PATH = "/ontology/releasability.yaml"


def refuse(path: Path, reason: str, detail: str) -> int:
    print(f"REFUSED: {path} {reason}", file=sys.stderr)
    print(f"  {detail}", file=sys.stderr)
    print("  A releasability declaration that names no assets makes every "
          "record unlabelled, which is a legal answer and therefore silent. "
          "Refusing to start instead.", file=sys.stderr)
    return 1


def check(path: Path) -> int:
    if not path.exists():
        return refuse(path, "is missing",
                      "nothing assembled it, or it was assembled from a "
                      "source that does not carry it")

    size = path.stat().st_size
    if size == 0:
        return refuse(path, "is zero bytes",
                      "a zero-byte declaration parses as a fleet of no "
                      "assets; this is what a nested single-file bind mount "
                      "into a writable parent creates")

    try:
        import yaml
    except ImportError:  # pragma: no cover - environment, not logic
        print("REFUSED: PyYAML is not available, so this check cannot run. "
              "A check that cannot run must not report success.",
              file=sys.stderr)
        return 1

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - any parse failure is a refusal
        return refuse(path, "does not parse as YAML", str(exc))

    if raw is None:
        return refuse(path, "parses to nothing",
                      f"{size} bytes, all of it comment or whitespace")

    if not isinstance(raw, dict):
        return refuse(path, "is not a mapping",
                      f"parsed as {type(raw).__name__}; `assets` cannot exist")

    assets = raw.get("assets") or {}
    # A document-wide default labels EVERY asset, so a file that sets one and
    # names no assets individually has declared something and is not what
    # this check refuses. The two are one rule -- "does anything get a label
    # from this document" -- and the readers apply the same precedence.
    default = raw.get("default_originator_nation")
    if not assets and not default:
        key = "absent" if "assets" not in raw else "present and empty"
        return refuse(path, "declares no assets",
                      f"`assets` is {key} and `default_originator_nation` is "
                      "unset; the file was authored and labels nobody")

    if not assets:
        print(f"OK: {path} names no assets individually but declares "
              f"default_originator_nation {default!r}, which labels all of "
              "them")
        return 0

    nations = sorted((raw.get("nations") or {}).keys())
    print(f"OK: {path} declares {len(assets)} assets across nations "
          f"{nations or '(none named)'}")
    return 0


def main(argv: list[str]) -> int:
    return check(Path(argv[1] if len(argv) > 1 else DEFAULT_PATH))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
