"""
Hero Scenario v3 runner — invokes each test as a subprocess so failures in
one test don't poison the others, and prints a summary.

This is the OSS-only test runner. Customer-feed tests (proprietary, sim-a,
System B egress, end-to-end fusion) live in the customer overlay at
openddil-customer-bundle/tests/run_all.py. Run them separately when the
customer overlay is mounted.

Exit code:
  0 = all tests PASS or SKIP
  1 = any test FAIL

Usage:
  python tests/hero_scenario_v3/run_all.py
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
PY = sys.executable

sys.path.insert(0, str(HERE))
from _helpers import wait_for_pipeline_ready  # noqa: E402

# --------------------------------------------------------------------------
# Discovery, not registration.
# --------------------------------------------------------------------------
# This runner used to carry a hand-maintained TESTS list. It ended at
# test_34 while test_35 through test_49 sat on disk beside it, so fifteen
# tests ran only when somebody named them individually -- green to their
# author on the day they were written, and absent from every run since. A
# runner that must be edited to see a test is a correct runner that runs
# nothing, and the omission is invisible precisely because the suite it
# prints is internally consistent: every test it names, it runs.
#
# So it discovers. A test file that exists is a test file that runs, and
# adding one is `git add`, not `git add` plus an edit here. The cost is
# that a half-finished test now fails the suite instead of being silently
# excluded, which is the right way round: a file named test_* that cannot
# run is a fact somebody should see.
#
# The contract for a discovered file is unchanged and unenforced by
# anything but convention: run standalone under this interpreter, print
# `PASS:` / `SKIP:` / `FAIL:` as the LAST line, exit 0 or 1.

# The fifteen that discovery picks up and the hand list never did. This is
# not a registry -- nothing reads it to decide what to run. It exists so
# the first discovering runs can say out loud what had been unrun, and it
# should be DELETED once these have been through a pass and their results
# are no longer news. Recorded in
# openddil-contracts/decisions/FOLLOW-UPS.md, 2026-09-23.
UNRUN_BEFORE_DISCOVERY = frozenset({
    "test_35_prognostics_distance_derivation.py",
    "test_36_prognostics_engine_hours.py",
    "test_37_prognostics_terrain_integral.py",
    "test_38_prognostics_barrel_life_dormant.py",
    "test_39_prognostics_to_fusion_integration.py",
    "test_40_multi_edge_attribution.py",
    "test_41_per_edge_entity_isolation.py",
    "test_42_windowed_emission_per_edge.py",
    "test_43_faust_regional_multi_cluster_consumption.py",
    "test_44_region_fleet_summary_aggregates.py",
    "test_45_region_wear_trends_from_derived_sustainment.py",
    "test_46_region_top_factors_topn.py",
    "test_47_dual_sum_sanity.py",
    "test_48_regional_pulldown_scope.py",
    "test_49_maintainer_edge_pulldown_scope.py",
})

_NUM = re.compile(r"^test_(\d+)")


def _order(name: str) -> tuple[int, str]:
    """Sort by the numeric prefix, so test_9 precedes test_10.

    Every test here happens to be zero-padded to two digits, which makes
    lexicographic order correct today and wrong on the first three-digit
    test. Sorting on the number costs one regex and removes the trap.
    """
    m = _NUM.match(name)
    return (int(m.group(1)) if m else 10**9, name)


def discover() -> list[str]:
    """Every `test_*.py` beside this file, in numeric order."""
    return sorted((p.name for p in HERE.glob("test_*.py")), key=_order)



def run_one(script: str) -> tuple[str, str, str]:
    path = HERE / script
    proc = subprocess.run([PY, str(path)], capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    last = out.splitlines()[-1] if out else ""
    if last.startswith("PASS:"):
        verdict = "PASS"
    elif last.startswith("SKIP:"):
        verdict = "SKIP"
    else:
        verdict = "FAIL"
    return script, verdict, last or "<no output>"


def main() -> int:
    print("Hero Scenario v3 (OSS) — DIS Ingestion + CM Lifecycle + Fusion Rules")
    print("=" * 60)

    tests = discover()
    print(f"... discovered {len(tests)} tests")
    newly = [t for t in tests if t in UNRUN_BEFORE_DISCOVERY]
    if newly:
        print(f"... {len(newly)} of them were never run by this runner "
              "before it discovered instead of registering:")
        for t in newly:
            print(f"      {t}")
    print()

    # Warm-up gate: don't run a single test until the pipeline's consumer
    # groups have joined and settled. Running against a cold pipeline is the
    # Phase 3.6 flaky-test class — the failures look like real bugs but are
    # just races. A gate timeout is a hard stop (exit 2), distinct from a
    # test failure (exit 1).
    print("... warm-up gate: waiting for pipeline consumer groups")
    if not wait_for_pipeline_ready():
        print()
        print("GATE FAILED — pipeline did not warm up; not running tests.")
        print("Check `docker compose ps` and the redpanda-connect / cm-service logs.")
        return 2

    results = []
    for t in tests:
        print(f"... running {t}")
        results.append(run_one(t))

    print()
    print("Summary")
    print("-" * 60)
    n_pass = sum(1 for _, v, _ in results if v == "PASS")
    n_skip = sum(1 for _, v, _ in results if v == "SKIP")
    n_fail = sum(1 for _, v, _ in results if v == "FAIL")
    for name, verdict, line in results:
        marker = {"PASS": "[OK]", "SKIP": "[~~]", "FAIL": "[XX]"}[verdict]
        print(f"  {marker} {name:42s} {verdict:5s}  {line}")
    print()
    print(f"PASS: {n_pass}   SKIP: {n_skip}   FAIL: {n_fail}")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
