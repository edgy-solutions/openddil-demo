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

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
PY = sys.executable

sys.path.insert(0, str(HERE))
from _helpers import wait_for_pipeline_ready  # noqa: E402

TESTS = [
    # DIS sidecar + Silver translation (Phase 2.5)
    "test_01_binary_pdu_acceptance.py",
    "test_02_malformed_pdu_resilience.py",
    "test_03_non_entity_state_dropped.py",
    "test_04_ontology_enrichment.py",
    "test_05_ontology_fallback.py",
    "test_06_sustainment_absent.py",
    "test_07_kafka_resilience.py",
    "test_08_truth_serum.py",
    "test_09_angle_quantity_roundtrip.py",
    "test_10_position_quantity_roundtrip.py",
    # cm-service lifecycle (Phase 3) — driven entirely by DIS data
    "test_12_cm_first_seen_init.py",
    "test_13_mod_compliance_flow.py",
    "test_14_critical_alert.py",
    "test_15_no_realert_on_stable_critical.py",
    "test_16_resolved_alert.py",
    # Pure-Python fusion rules unit tests (Phase 3.5) — no customer shapes
    "test_24_fusion_rules_unit.py",
    # Playwright UI smoke tests (Phase 4d). Drive a headless browser against
    # the running frontend. SKIP gracefully if Playwright / a browser binary
    # is not installed — see _ui_helpers.py. Tests 32/33 exercise the real
    # toxiproxy hq-link DDIL mechanic (ADR-0021), not a UI simulation.
    "test_29_ui_maintainer_view_loads.py",
    "test_30_ui_regional_aggregation.py",
    "test_31_ui_hq_aggregate_metrics.py",
    "test_32_ui_ddil_disconnect_banner.py",
    "test_33_ui_ddil_reconnect_clears.py",
    "test_34_ui_demo_mock_banners.py",
]


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
    for t in TESTS:
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
