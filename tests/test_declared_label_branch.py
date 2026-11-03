"""Runs the real declared_label branch on the real binary, with the store swapped out.

ADR-0050 s2.6: a failed lookup stamps nothing, and a store outage withholds and
never mislabels. Only the sql_select is replaced, by a mapping that answers or
throws by case; try, cached, set, catch, switch, get and result_map are the file
as written. A text guard cannot show this: `cached` reads a stored failure back
with no error flag, so a branch that reads correctly can still overwrite the
known answer on the second record of an outage.

OPENDDIL_BLOBL names the redpanda-connect binary and is skipped otherwise. The
config goes in on /dev/stdin, so this needs a Linux binary.
"""
import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

DECLARED = Path(__file__).resolve().parent.parent / "dynamic-mappings" / "declared-label.yaml"
BLOBL = os.environ.get("OPENDDIL_BLOBL")

MOCK = '''root = match meta("mode") {
  "row_atl" => [{"originator_nation":"ATL","releasable_json":"[\\"BDR\\"]"}],
  "row_bdr" => [{"originator_nation":"BDR","releasable_json":"[]"}],
  "none" => [],
  _ => throw("store down")
}'''

ATL = ("ATL", '["BDR"]', None)
BDR = ("BDR", "[]", None)
NO_ROW = (None, None, None)
FAILED = (None, None, "true")

# Waits long enough that a TTL of 1 s has passed, at 300 ms a record.
WAIT = [("wait", "none", NO_ROW)] * 4

ANSWERS_THEN_FAILURES = [
    ("a1", "row_atl", ATL),
    ("a1", "down", ATL),     # failed: the last answer
    ("a2", "none", NO_ROW),
    ("a2", "down", NO_ROW),  # failed: the last answer was no row, which is not a failure
    ("a3", "down", FAILED),  # failed, nothing known
    ("a3", "row_atl", ATL),  # store back: the marker does not stick
    ("a3", "down", ATL),
    ("a1", "row_bdr", BDR),  # a new answer replaces the known one
    ("a1", "down", BDR),
    ("a4", "row_atl", ATL),
    ("a4", "none", NO_ROW),  # the store says no row: no stale label
    ("a4", "down", NO_ROW),
]
INSIDE_THE_FILE_TTL = [
    ("b1", "row_atl", ATL),
    ("b1", "down", ATL),     # a hit, no lookup at all
    ("b2", "down", FAILED),
    ("b2", "row_atl", FAILED),  # a failure is cached too: withheld up to the TTL after the store returns
]
A_CACHED_FAILURE_IS_NOT_AN_ANSWER = [
    ("c1", "row_atl", ATL), *WAIT,
    ("c1", "down", ATL),     # a real failure, catch fires
    ("c1", "down", ATL),     # the failure read back from the cache, with no error flag
    ("c1", "down", ATL), *WAIT,
    ("c1", "down", ATL),     # past the TTL: fails again, known intact
    ("c2", "down", FAILED),
    ("c2", "down", FAILED), *WAIT,  # a cached failure must not become a known "no row"
    ("c1", "row_bdr", BDR),  # store back, past the TTL
    ("c2", "none", NO_ROW),
]


def _config(cases, ttl):
    doc = yaml.safe_load(DECLARED.read_text(encoding="utf-8"))
    if ttl:
        cache = next(c for c in doc["cache_resources"] if c["label"] == "declared_labels")
        cache["memory"]["default_ttl"] = ttl
    steps = doc["processor_resources"][0]["branch"]["processors"][0]["try"]
    assert "sql_select" in steps[0]["cached"]["processors"][0], "the file's shape moved"
    steps[0]["cached"]["processors"] = [{"mapping": MOCK}]
    listing = json.dumps([{"seq": i, "id": c[0], "mode": c[1]} for i, c in enumerate(cases)])
    doc["input"] = {"generate": {"count": len(cases), "interval": "300ms", "mapping": (
        f"let c = {listing}.index(counter() - 1)\n"
        "meta mode = $c.mode\nroot.seq = $c.seq\nroot.entity_id_urn = $c.id\n")}}
    doc["pipeline"] = {"processors": [{"resource": "declared_label"}, {"mapping": (
        'root = {"seq":this.seq,"orig":meta("declared_originator"),'
        '"rel":meta("declared_releasable"),"failed":meta("declared_lookup_failed")}')}]}
    doc["output"] = {"stdout": {}}
    doc["logger"] = {"level": "NONE"}
    doc["http"] = {"enabled": False}
    return yaml.safe_dump(doc)


@pytest.mark.skipif(not BLOBL, reason="set OPENDDIL_BLOBL to the redpanda-connect binary to run the branch")
@pytest.mark.parametrize("cases,ttl", [
    (ANSWERS_THEN_FAILURES, "1ms"),
    (INSIDE_THE_FILE_TTL, None),
    (A_CACHED_FAILURE_IS_NOT_AN_ANSWER, "1s"),
], ids=["answers-then-failures", "inside-the-file-ttl", "a-cached-failure-is-not-an-answer"])
def test_the_branch_never_loses_or_invents_an_answer(cases, ttl):
    r = subprocess.run([BLOBL, "run", "/dev/stdin"], input=_config(cases, ttl), text=True,
                       capture_output=True, timeout=120)
    assert r.returncode == 0, r.stderr
    got = {}
    for line in r.stdout.splitlines():
        if line.startswith('{"'):
            d = json.loads(line)
            got[d["seq"]] = (d["orig"], d["rel"], d["failed"])
    assert got == {i: c[2] for i, c in enumerate(cases)}
