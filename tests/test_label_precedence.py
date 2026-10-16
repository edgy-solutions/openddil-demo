"""Label precedence in sim-dis-mapping.yaml (ADR-0050 s2.6):
declaration > per-asset row > document default > unlabelled.

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
SHAPE = re.compile(
    r"let rel = if \$declared\.length\(\) > 0 \{ \$declared \} "
    r"else \{ \$rel_doc\.assets\.get\(\$src\.entity_id_urn\)\.or\(\$rel_default\) \}")
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


def test_both_sites_use_declaration_first_shape():
    text = MAPPING.read_text(encoding="utf-8")
    assert len(re.findall(r"let rel = ", text)) == 2
    assert len(SHAPE.findall(text)) == 2


CASES = [
    # (declared, row, default, expected)
    ("ATL", None, "BDR", "ATL"),
    ("ATL", "BDR", None, "ATL"),
    (None, "BDR", "ATL", "BDR"),
    (None, None, "BDR", "BDR"),
    (None, None, None, None),
]


@pytest.mark.skipif(not BLOBL, reason="set OPENDDIL_BLOBL to the redpanda-connect binary to execute the mapping")
@pytest.mark.parametrize("declared,row,default,expected", CASES)
def test_precedence_executes(declared, row, default, expected, tmp_path):
    blocks = _blocks()
    assert len(blocks) == 2
    meta = {}
    if declared:
        meta = {"declared_originator": declared, "declared_releasable": "[]"}
    doc = {"default_originator_nation": default,
           "assets": {"dis:1:1:7": {"originator_nation": row, "releasable_to": []}} if row else {}}
    inp = {"meta": meta, "rel_doc": doc, "src": {"entity_id_urn": "dis:1:1:7"}}
    for block in blocks:
        mapping = ("let rel_doc = this.rel_doc\nlet src = this.src\n" + block +
                   "\nroot.originator_nation = $rel.originator_nation.or(deleted())\n")
        r = subprocess.run([BLOBL, "blobl", mapping], input=json.dumps(inp), text=True,
                           capture_output=True, cwd=tmp_path, timeout=60)
        assert r.returncode == 0, r.stderr
        got = json.loads(r.stdout).get("originator_nation") if r.stdout.strip() else None
        assert got == expected
