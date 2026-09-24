"""ONE predicate: the egress gate and the read path agree — ADR-0043.

THIS IS THE TEST SLICE 2 EXISTS TO PASS. The whole design rests on a single
claim: egress is not a second release rule, it is the read rule evaluated with
the destination in the subject slot. That claim is cheap to state and easy to
quietly break — someone adds a clause to the SQL, or tightens the Python, and
for months the two implementations disagree only about rows nobody looked at.

So the two are compared where they can actually disagree: the SQL runs in
Postgres, over the same fixture the Python predicate evaluates in process,
and the verdicts are compared row for row for every subject in the corpus.
The interesting disagreements are not about the obvious rows — they are about
NULL versus empty array, about `&&` on an empty array, and about the
entitled-to-nothing subject, and those only have answers when a real database
gives them.

THE FIXTURE IS NOT THE FLEET. It is deliberately nastier: the fleet has no
aggregates, no NULL-authored rows and no empty-array rows, so a fixture drawn
from it would exercise one clause of a two-clause predicate and pass.

Run: `python tests/hero_scenario_v3/test_51_egress_read_agreement.py`
Needs: postgres-hq. (topaz is used when it is up, and stood in for otherwise —
see the SUBJECTS note below.)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[2] / "egress"))
sys.path.insert(0, str(Path(__file__).parents[2] / "gateway"))

# pep.py reads both of these AT IMPORT and exits if either is missing — it is
# a service, not a library. Setting them here does not make this test talk to
# either one; the only thing imported from pep is a pure function that renders
# a string.
os.environ.setdefault("OPENDDIL_ELECTRIC_URL", "http://electric:3000")
os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://localhost:8383")

from _helpers import fail_, pass_, query_postgres, skip_  # noqa: E402

TEST = "test_51_egress_read_agreement"
FIXTURE_TABLE = "egress_agreement_fixture"

# Every entitlement in the corpus, plus the two edges a corpus can produce.
# Named rather than fetched from Topaz on purpose: this test is about the two
# PEPs agreeing with each other, and it must keep working — and keep being
# worth reading — when the PDP is not up. What the PDP returns for each
# subject is checked in test_50 and by the gate's own startup line.
SUBJECTS = {
    "operator.atlantia":  ["ATL"],
    "operator.borduria":  ["BDR"],
    "liaison.coalition":  ["ATL", "BDR"],
    "c2-stand-in-atl":    ["ATL"],
    "entitled-to-nothing": [],
    "unknown-nation":     ["ZZZ"],
}

# (id, originator_nation, releasable_to) — None is SQL NULL / Python absent.
FIXTURE = [
    ("authored-atl-closed",     "ATL",  []),
    ("authored-atl-to-bdr",     "ATL",  ["BDR"]),
    ("authored-bdr-closed",     "BDR",  []),
    ("authored-bdr-to-atl",     "BDR",  ["ATL"]),
    ("authored-atl-null-rel",   "ATL",  None),
    ("aggregate-to-both",       None,   ["ATL", "BDR"]),
    ("aggregate-to-atl",        None,   ["ATL"]),
    # THE COMPOSED-EMPTY AGGREGATE. Releasable to nobody as a real outcome of
    # intersecting audiences, not as a missing label — and on the wire
    # indistinguishable from one, which is why both sides must refuse it.
    ("aggregate-empty",         None,   []),
    ("unlabelled-both-null",    None,   None),
    # proto3 materialises an unset string as "". A row that reached the
    # database carrying "" rather than NULL is the shape a labelling bug
    # produces, and the two sides must not disagree about it.
    ("empty-string-author",     "",     []),
    ("third-nation",            "ZZZ",  []),
    ("third-nation-to-atl",     "ZZZ",  ["ATL"]),
]


def as_label(originator, releasable):
    """The fixture row as the gate would see it on the wire."""
    from gate import extract_label

    record: dict = {}
    if originator is not None:
        record["originator_nation"] = originator
    if releasable is not None:
        record["releasable_to"] = releasable
    return extract_label(record)


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def array_literal(value) -> str:
    if value is None:
        return "NULL::text[]"
    if not value:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ", ".join(sql_literal(v) for v in value) + "]::text[]"


def build_fixture_table() -> None:
    rows = ", ".join(
        f"({sql_literal(i)}, {sql_literal(o)}, {array_literal(r)})"
        for i, o, r in FIXTURE
    )
    query_postgres(
        f"DROP TABLE IF EXISTS {FIXTURE_TABLE}; "
        f"CREATE TABLE {FIXTURE_TABLE} ("
        "  id text PRIMARY KEY,"
        "  originator_nation text,"
        "  releasable_to text[]"
        f"); INSERT INTO {FIXTURE_TABLE} VALUES {rows};"
    )


def sql_admits(nations: list[str]) -> set[str]:
    from pep import policy_predicate

    where = policy_predicate(nations)
    rows = query_postgres(
        f"SELECT id FROM {FIXTURE_TABLE} WHERE {where} ORDER BY id;")
    return {r[0] for r in rows if r and r[0]}


def gate_admits(nations: list[str]) -> set[str]:
    from gate import compile_predicate

    predicate = compile_predicate(nations)
    return {i for i, o, r in FIXTURE if predicate(as_label(o, r))}


def main() -> int:
    try:
        query_postgres("SELECT 1;")
    except Exception as exc:  # noqa: BLE001
        skip_(TEST, f"postgres-hq not reachable: {exc}")
        return 0

    try:
        from gate import compile_predicate  # noqa: F401
        from pep import policy_predicate  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        fail_(TEST, f"could not import both predicates: {exc}")
        return 1

    build_fixture_table()

    disagreements = []
    coverage: set[str] = set()
    for subject, nations in SUBJECTS.items():
        sql = sql_admits(nations)
        gate = gate_admits(nations)
        coverage |= sql | gate
        if sql != gate:
            only_sql = sorted(sql - gate)
            only_gate = sorted(gate - sql)
            disagreements.append(
                f"{subject} ({nations or 'no entitlements'}): "
                f"read-path-only={only_sql} egress-only={only_gate}")

    # A test in which neither side ever admits anything would agree perfectly
    # and prove nothing. Assert that the comparison had something to compare.
    if not disagreements and len(coverage) < 6:
        fail_(TEST, f"the two agreed, but only {len(coverage)} rows were ever "
                    "admitted by anything — the fixture is not exercising the "
                    "predicate")
        return 1

    query_postgres(f"DROP TABLE IF EXISTS {FIXTURE_TABLE};")

    if disagreements:
        fail_(TEST, "the egress gate and the read path DISAGREE: "
                    + "; ".join(disagreements))
        return 1

    pass_(TEST, f"{len(SUBJECTS)} entitlements x {len(FIXTURE)} rows: "
                "identical verdicts from the SQL in Postgres and the "
                "compiled predicate in process")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
