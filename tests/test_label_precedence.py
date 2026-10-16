"""Label precedence in sim-dis-mapping.yaml (ADR-0050 s2.6):
declaration > per-asset row > sidecar nation stamp > document default >
unlabelled.

Two layers. The shape test pins the `let rel =` expression at both stamp
sites, and always runs. The execution test runs the real `let rel_default` ..
`let rel` block of each site through `redpanda-connect blobl`; it runs when
OPENDDIL_BLOBL names the redpanda-connect binary and is skipped otherwise.
"""
import json
import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

MAPPING = Path(__file__).resolve().parent.parent / "dynamic-mappings" / "sim-dis-mapping.yaml"
EFFECTOR = Path(__file__).resolve().parent.parent / "dynamic-mappings" / "dis-effector.yaml"
SHAPE = re.compile(
    r"let rel = if \$declared\.length\(\) > 0 \{ \$declared \} "
    r"else \{ \$rel_doc\.assets\.get\(\$src\.entity_id_urn\)\.or\(\$fallback\) \}")
EFFECTOR_SHAPE = re.compile(
    r"let rel = \$rel_doc\.assets\.get\(this\.launcher_urn\)\.or\(\$fallback\)")
# The block each site reads the sidecar's stamp from: the Remove branch's $src
# carries it under provenance, the Entity State branch's under origin_node,
# and the effector arm's `this` (a Fire / Detonation record) under provenance.
STAMP_READ = [
    r"\$src\.provenance\.stamped_nation",
    r"\$src\.origin_node\.stamped_nation",
]
EFFECTOR_STAMP_READ = r"this\.provenance\.stamped_nation"
BLOBL = os.environ.get("OPENDDIL_BLOBL")


def _blocks():
    """Each site's `let rel_default` .. `let rel` lines, meta() reads swapped
    for fields of the input so `blobl` can supply them."""
    lines = MAPPING.read_text(encoding="utf-8").splitlines()
    out, cur = [], None
    for ln in lines:
        if ln.strip().startswith("let rel_default"):
            cur = []
        if cur is not None:
            cur.append(ln)
            if ln.strip().startswith("let rel = "):
                out.append(textwrap.dedent("\n".join(cur)))
                cur = None
    return [b.replace('meta("declared_originator")', "this.meta.declared_originator")
             .replace('meta("declared_releasable")', "this.meta.declared_releasable")
            for b in out]


def _effector_block():
    """The effector arm's `let rel_default` .. `let rel` lines."""
    out, cur = [], None
    for ln in EFFECTOR.read_text(encoding="utf-8").splitlines():
        if ln.strip().startswith("let rel_default"):
            cur = []
        if cur is not None:
            cur.append(ln)
            if ln.strip().startswith("let rel = "):
                out.append(textwrap.dedent("\n".join(cur)))
                cur = None
    assert len(out) == 1
    return out[0]


def test_both_sites_use_declaration_first_shape():
    text = MAPPING.read_text(encoding="utf-8")
    assert len(re.findall(r"let rel = ", text)) == 2
    assert len(SHAPE.findall(text)) == 2
    assert EFFECTOR_SHAPE.search(_effector_block())


def _raw_blocks():
    """The three label blocks as text, meta() reads untouched, each paired
    with the pattern its stamp must be read from."""
    lines = MAPPING.read_text(encoding="utf-8").splitlines()
    out, cur = [], None
    for ln in lines:
        if ln.strip().startswith("let rel_default"):
            cur = []
        if cur is not None:
            cur.append(ln)
            if ln.strip().startswith("let rel = "):
                out.append("\n".join(cur))
                cur = None
    assert len(out) == 2
    return list(zip(["remove", "entity-state"], out, STAMP_READ)) + [
        ("effector", _effector_block(), EFFECTOR_STAMP_READ)]


def test_every_label_block_ranks_the_stamp_below_the_row_above_the_default():
    """Text guard, runs without blobl: each of the three blocks reads
    stamped_nation from the right record block, folds it ahead of the file
    default, and in its `let rel =` line the stamp (via $fallback) comes
    after `assets`."""
    for name, block, read in _raw_blocks():
        assert "stamped_nation" in block, f"{name}: no stamped_nation"
        assert re.search(read, block), f"{name}: stamp not read from {read}"
        i, j = block.find("let stamped"), block.find("let fallback")
        assert 0 <= i < j and "stamped_nation" in block[i:j], f"{name}: no let stamped"
        fb = re.search(r"let fallback = [^\n]*", block)
        assert fb, f"{name}: no let fallback"
        assert fb.group(0).index("$stamped") < fb.group(0).index("$rel_default"), \
            f"{name}: the default is ahead of the stamp"
        rel = [ln for ln in block.splitlines() if ln.strip().startswith("let rel = ")][0]
        assert "assets" in rel and "$fallback" in rel, f"{name}: rel line {rel!r}"
        assert rel.index("assets") < rel.index("$fallback"), f"{name}: stamp ahead of assets"
        assert "$rel_default" not in rel, f"{name}: the default bypasses the stamp"


CASES = [
    # (declared, row, stamp, default, expected)
    ("ATL", None, None, "BDR", "ATL"),
    ("ATL", "BDR", None, None, "ATL"),
    (None, "BDR", None, "ATL", "BDR"),
    (None, None, None, "BDR", "BDR"),
    (None, None, None, None, None),
    # the sidecar stamp: used with no declaration and no row ...
    (None, None, "ATL", None, "ATL"),
    # ... beaten by a row ...
    (None, "BDR", "ATL", None, "BDR"),
    # ... and by a declaration ...
    ("BDR", None, "ATL", None, "BDR"),
    # ... and beating the file default.
    (None, None, "ATL", "BDR", "ATL"),
]


def _run(mapping, inp, tmp_path):
    r = subprocess.run([BLOBL, "blobl", mapping], input=json.dumps(inp), text=True,
                       capture_output=True, cwd=tmp_path, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout).get("originator_nation") if r.stdout.strip() else None


def _rel_doc(row, default):
    return {"default_originator_nation": default,
            "assets": {"dis:1:1:7": {"originator_nation": row, "releasable_to": []}} if row else {}}


@pytest.mark.skipif(not BLOBL, reason="set OPENDDIL_BLOBL to the redpanda-connect binary to execute the mapping")
@pytest.mark.parametrize("declared,row,stamp,default,expected", CASES)
def test_precedence_executes(declared, row, stamp, default, expected, tmp_path):
    blocks = _blocks()
    assert len(blocks) == 2
    meta = {}
    if declared:
        meta = {"declared_originator": declared, "declared_releasable": "[]"}
    # Remove reads the stamp from provenance, Entity State from origin_node; the
    # other block carries a decoy, so a read from the wrong block shows.
    for block, home in zip(blocks, ("provenance", "origin_node")):
        src = {"entity_id_urn": "dis:1:1:7"}
        other = "origin_node" if home == "provenance" else "provenance"
        if stamp:
            src[home] = {"stamped_nation": stamp}
            src[other] = {"stamped_nation": "BDR" if stamp == "ATL" else "ATL"}
        inp = {"meta": meta, "rel_doc": _rel_doc(row, default), "src": src}
        mapping = ("let rel_doc = this.rel_doc\nlet src = this.src\n" + block +
                   "\nroot.originator_nation = $rel.originator_nation.or(deleted())\n")
        assert _run(mapping, inp, tmp_path) == expected


EFFECTOR_CASES = [
    # (row, stamp, default, expected): a launch has no declaration of its own
    (None, "ATL", None, "ATL"),
    ("BDR", "ATL", None, "BDR"),
    (None, "ATL", "BDR", "ATL"),
    (None, None, "BDR", "BDR"),
    (None, None, None, None),
]


@pytest.mark.skipif(not BLOBL, reason="set OPENDDIL_BLOBL to the redpanda-connect binary to execute the mapping")
@pytest.mark.parametrize("row,stamp,default,expected", EFFECTOR_CASES)
def test_effector_arm_takes_the_launchers_stamp(row, stamp, default, expected, tmp_path):
    inp = {"rel_doc": _rel_doc(row, default), "launcher_urn": "dis:1:1:7", "provenance": {}}
    if stamp:
        inp["provenance"]["stamped_nation"] = stamp
    mapping = ("let rel_doc = this.rel_doc\n" + _effector_block() +
               "\nroot.originator_nation = $rel.originator_nation.or(deleted())\n")
    assert _run(mapping, inp, tmp_path) == expected
