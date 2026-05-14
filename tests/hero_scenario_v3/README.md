# Hero Scenario v3 — Binary DIS Ingestion Verification

End-to-end verification that the Phase 2 binary DIS sidecar (`dis_ingestor.py`),
the ontology-aware Bloblang mapping (`sim-dis-mapping.yaml`), and the downstream
Silver topic (`raw-sensor-stream`) all behave correctly.

## Prerequisites

- `docker compose up -d` from `openddil-demo/`, with the openddil-sensor-ingest
  service, redpanda-connect (with `/ontology` mounted), redpanda-edge, and
  redpanda-init all running.
- Sidecar logs show `Listening on UDP 0.0.0.0:62040` and `Kafka producer ready`.
- Python 3.11+ on the host (uses only stdlib + `requests`).

## Layout

```
hero_scenario_v3/
├── README.md                            (this file)
├── _helpers.py                          (shared kafka/metrics/UDP helpers)
├── run_all.py                           (runs all 8 tests, reports summary)
├── test_01_binary_pdu_acceptance.py
├── test_02_malformed_pdu_resilience.py
├── test_03_non_entity_state_dropped.py
├── test_04_ontology_enrichment.py
├── test_05_ontology_fallback.py
├── test_06_sustainment_absent.py
├── test_07_kafka_resilience.py
└── test_08_truth_serum.py
```

## Running

```powershell
# From openddil-demo/
python tests\hero_scenario_v3\run_all.py

# Or individually:
python tests\hero_scenario_v3\test_01_binary_pdu_acceptance.py
```

Each test exits with code `0` on PASS and `1` on FAIL, printing a single
`PASS:` or `FAIL:` line plus diagnostic context.

## Test Index

| # | Test                                | What it asserts                                                              |
|---|-------------------------------------|------------------------------------------------------------------------------|
| 1 | `test_01_binary_pdu_acceptance`     | Valid Entity State PDU → JSON on `ingress-dis-raw` with structured fields    |
| 2 | `test_02_malformed_pdu_resilience`  | Garbage bytes → `dis_decode_errors_total` increments, sidecar stays alive    |
| 3 | `test_03_non_entity_state_dropped`  | Fire PDU (type 2) counted on receive but dropped before Kafka                |
| 4 | `test_04_ontology_enrichment`       | M1A2 SEPv3 triplet → Silver event with `asset.platform_variant=M1A2-SEPv3`   |
| 5 | `test_05_ontology_fallback`         | Unknown triplet → Silver event with `asset.platform_variant=UNKNOWN`         |
| 6 | `test_06_sustainment_absent`        | DIS-sourced Silver event carries no `sustainment` block                      |
| 7 | `test_07_kafka_resilience`          | Sidecar survives a Kafka outage and resumes on broker return                 |
| 8 | `test_08_truth_serum`               | Architectural seal: mock thermal injected via HTTP cannot reach algorithms   |

## Honesty notes (Phase 1 pattern)

- Tests 4, 5, 6 require protobuf decoding of `raw-sensor-stream`. They depend
  on `openddil-contracts/gen/python` being importable. If those generated
  modules are missing, the affected tests report `SKIP:` with the missing
  module name, not a false PASS.
- Test 7 toggles Redpanda via `docker compose stop/start redpanda-edge` — it
  takes ~30 s. The pass criterion is "sidecar process still alive after
  recovery", not "PDU was preserved", because the sidecar does not
  persistently buffer.
- Test 8 verifies the architectural seal carried over from v2.1 — i.e., the
  current `sim-dis-mapping.yaml` does NOT pass through any sustainment block,
  so mock thermal data cannot reach algorithms even via the diagnostic HTTP
  injection path. The 200 K / 200 °F unit-handling assertion is exercised by
  the algorithm-level unit tests in `openddil-tactical-agents`, not here.

## Tracked follow-ups

Open items deliberately scoped *out* of the phase that introduced them.

- **Run the Playwright suite (tests 29–34) in an environment with Chromium.**
  Added in Phase 4d. They have only ever been verified to *SKIP* cleanly
  (no browser in the dev environment) — never executed. A never-run test
  can have a wrong selector or timeout and still look fine. Until a real
  run (CI or a local box with `playwright install chromium`) passes, the
  Playwright suite is written, not a verified safety net. Tests 32/33
  especially — the toxiproxy-sever / freeze-overlay assertions — need a
  real run to count.
- **Make `consume_asset_cm_state_for` poll-until-applied.**
  `test_13_mod_compliance_flow` is a pre-existing timing flake: it submits a
  `ModApplied` CmEvent via the CLI, `sleep(5)`s, then consumes a single
  `asset-cm-state` snapshot. Under full-suite load the
  CLI→Kafka→Restate→cm-service→emit chain can outrun the sleep, so the
  snapshot is pre-apply (`state=2`, not `4`). It passes on isolated re-run.
  The Phase 4d warm-up gate does *not* fix this — it addresses
  consumer-group readiness, a different flake class. Fix:
  `consume_asset_cm_state_for` should poll until the expected state appears
  (or timeout), not sleep-then-snapshot.
