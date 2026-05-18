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

**Canonical home for open items deliberately scoped *out* of the phase
that introduced them.** Cross-domain (tests, engine, COP) — kept in one
place so a future reader has *one* file to audit. If you're adding an
item: add it here, even if it isn't a test-runner item.

### Tests

1. **Run the Playwright suite (tests 29–34) in an environment with Chromium.**
   Phase 4d. They have only ever been verified to *SKIP* cleanly (no
   browser in the dev environment) — never executed. A never-run test
   can have a wrong selector or timeout and still look fine. Until a
   real run (CI or a local box with `playwright install chromium`)
   passes, the Playwright suite is written, not a verified safety net.
   Tests 32/33 especially — the toxiproxy-sever / freeze-overlay
   assertions — need a real run to count.
2. **Make `consume_asset_cm_state_for` poll-until-applied.**
   `test_13_mod_compliance_flow` is a pre-existing timing flake: submits
   a `ModApplied` CmEvent via the CLI, `sleep(5)`s, then consumes a
   single `asset-cm-state` snapshot. Under full-suite load the
   CLI→Kafka→Restate→cm-service→emit chain can outrun the sleep, so the
   snapshot is pre-apply (`state=2`, not `4`). Passes on isolated re-run.
   Phase 4d's warm-up gate does *not* fix this — it addresses
   consumer-group readiness, a different flake class. Fix: poll until
   the expected state appears (or timeout), not sleep-then-snapshot.
3. **customer-overlay four-shape parametric test for the Unit feed.** Phase 5
   build pass. The customer-overlay re-plumb verified one *stationary* sample
   each of Unit and Sensor; it never exercised: a moving asset (non-zero
   speed/heading — validates the LLM-inferred `m/s` / `deg` units
   end-to-end), a Red-side asset (`side: "red"` → `FORCE_OPPOSING`),
   a different `id` / `platform_type` (proves the alias/ontology paths
   aren't accidentally hard-coded to IRON-01 / SHORAD_Radar), and a
   `unitNumber`-only variant (no `id`, currently DLQ — confirm intent).
   **Until this closes, customer-overlay's kinematics are NOT cleared as Phase 5
   derivation input** (DIS sims are the step-zero feed; this is a
   gating-but-not-blocking item for customer-overlay → engine wiring).

### Engine (Phase 5 prognostics)

4. **Barrel-life is built but dormant pending Fire/Detonation PDU
   ingestion.** The model has the shape and passes unit tests;
   `_derive_barrel_life` correctly returns `None` while
   `state.rounds_fired == 0`. The wiring side of this — DIS sidecar
   extension to ingest Fire/Detonation PDUs, new Bloblang mapping, the
   `prognostics.accumulators.record_round_fired()` call — is **scoped as
   a separate future phase**, not a Phase 5 tail; see
   [Future phases](#future-phases) below. The follow-up here is the
   *code-level placeholder* that keeps the dormancy visible to future
   readers; the future phase is the work that closes the dormancy.
   `test_38_prognostics_barrel_life_dormant` asserts the dormancy on
   every run so a clean test suite cannot hide it.
5. **Find or define an engine-on signal; replace the observed-time
   stand-in.** Phase 5's engine-hours model uses *observed time* (first
   to last sample) as a stand-in — a deliberate overestimate that
   counts parked-but-visible time. Honest enough for the mechanism
   demo (ADR-0020 names it explicitly in the demo narrative), but it
   needs a real engine-on signal before any operational claim about
   engine hours can be made. Candidates: a DIS protocol extension, a
   sim-side flag in a future feed, or a derivable proxy (e.g.
   non-zero linear/angular velocity over a window).

### COP / consumers

6. **Surface derived sustainment in the COP** *(post-hierarchy pass)*.
   ADR-0020 originally ruled the COP surface for derived sustainment
   OUT of Phase 5 scope. **Phase 5 step 2 landed two of the four
   pieces:** the `logistics-fusion-service` subscription
   (`fusion-service-derived` consuming `derived-sustainment` → routed to
   `AssetLogistics/on_derived_sustainment`), and the small `_eval_wear`
   enhancement (reads `remaining_useful_life.unit == "%"`, stamps
   `origin = ORIGIN_DERIVED` on the resulting `ConstrainingFactor` from
   `sustainment.value_provenance["*"]`). `test_39` verifies both
   end-to-end. **What remains for the COP-surface pass:** the projector
   mapping that exposes `derived-sustainment` on the COP surface, and
   the measured-vs-derived rendering treatment (ADR-0017 honesty
   extended to derived data — distinct visual treatment so consumers
   can never mistake derived for measured). The remainder comes *after*
   hierarchical restoration per ADR-0022 sequencing.

7. **Projector multi-handler switch from env-default to message-field
   provenance — CLOSED in Phase 6b §A (2026-05-17).** The four
   remaining per-asset handlers (`cm_state`, `logistics_status`,
   `telemetry_windows`, `tactical_events`) now read `edge_id` /
   `region_id` from the inbound message via the shared
   `resolve_provenance_from_{proto,dict,top_level}` helpers in
   `handlers/base.py`. Coordinated emitter upgrades landed in
   cm-service (`AsMaintainedRecord` gains the fields; observe()
   stamps; `_reanalyze` preserves across the proto round-trip;
   CloudEvent data block carries them for tactical events),
   logistics-fusion-service (`_extract_origin` / `_refresh_origin`
   reading from proto-camelCase Provenance, snake-case Provenance,
   and asset-cm-state's JSON envelope top-level keys), and
   faust-edge (`_emit_window_for_asset` stamps WindowedTelemetry
   .provenance from `OPENDDIL_EDGE_ID` env). Verified live —
   `SELECT DISTINCT edge_id` returns 3 populated edges for
   `telemetry_latest_state`, `asset_cm_state`,
   `asset_logistics_status`, and `tactical_events`. The
   `WindowedTelemetry` proto gained `provenance = 21` in §A; the
   end-to-end exercise of that path is the new follow-up #11.

8. **Per-edge UI link toggle wiring.** The existing UI link toggle in
   the HQ header drives a single toxiproxy proxy (`hq-link` on 8474),
   which all three 6a edge-hq-bridges write through. Per-edge
   severability ("sever edge-02's bridge only") needs per-edge HQ
   broker listeners — Redpanda advertises ONE address, so multiple
   proxies don't actually achieve independent sever today (the same
   Phase 4c.5 convincing-fake failure mode applied one tier up). Wire
   the UI control surface for per-edge severance once the broker side
   supports it. Pairs with multi-edge `edge_buffer_monitor` (per-edge
   `bridge-group-edge-NN` lag) — they're the same demo capability seen
   from two angles. 6c rewire scope.

9. **HTTP diagnostic input attribution.** The `redpanda-connect-01` DIS
   mapper accepts diagnostic JSON on port 9999 (single-instance, host-
   mapped only on `-01`). Those messages don't carry `origin_node` from
   sensor-ingest, so the DIS-mapper Bloblang stamps
   `Provenance.edge_id = ""` and the projector's `telemetry_latest`
   handler falls back to its env-default (`edge-01` on instance-01)
   with a rate-limited WARN. Defensible for diagnostic-only use; a
   small env-stamping wrapper on the HTTP path would close it. Low
   priority — exists so a future debugger knows why the WARN line shows
   up on `*-from-9999` traffic.

10. **Restore per-asset 3D model rendering in regional / HQ / zoom-in
   views.** Phase 4c removed `AssetSpawner` (the GLB-model renderer)
   when the simulator plumbing was deleted; the regional and HQ 3D maps
   currently render every asset as a status-colored sphere (a "dome"
   from the top-down camera). The `DdilNetworkLink` comm lines and
   `LogisticsHubNode` markers survived; the per-platform tank / radar /
   launcher / UGV silhouettes did not. The status badges that used to
   float on lines above each asset are also gone. **When this work
   lands, the deliverable starts with a survey** — exactly which models
   disappeared, where they were rendered (regional map / HQ theater /
   AssetDeepDive zoom-in / floating status labels), why each was
   removed, and what's still wired vs. what needs reconstruction.
   User-provided GLBs go in `frontend/public/models/`; loader is
   `@react-three/drei`'s `useGLTF` with `<Suspense>` boundaries.
   Status-color treatment likely lives on an emissive base ring under
   each model rather than recoloring baked GLB materials. Eye-candy
   pass (2026-05-15) deliberately left this out as "model fidelity,"
   not "frame parity."

11. **Sustainment-data test fixtures for the windowed-path end-to-end
    exercise.** Phase 6b §A added `WindowedTelemetry.provenance` (proto
    field 21), faust-edge stamps it from env, and the projector
    `telemetry_windows` handler reads it via
    `resolve_provenance_from_proto` — all verified at the code level.
    What §A did *not* close is the live-pipeline exercise: faust-edge's
    `_emit_window_for_asset` only emits when sustainment-window
    accumulators flush, and the current DIS-only test traffic
    (EntityState PDUs only, no Fire / Detonation / sustainment
    payloads) never drives the sustainment-window emission path. The
    `asset_telemetry_windows` table therefore stays empty under
    hero_scenario_v3, and `SELECT DISTINCT edge_id` returns zero
    rows — *not because stamping is broken, but because no row was
    ever emitted to test the stamping on*. **Closing this needs a
    sustainment-data test fixture** — a synthetic feed that pushes
    enough samples per edge to trigger window flushing on each, so
    `test_42_windowed_emission_per_edge` becomes a real positive +
    negative isolation assertion the way test_41 is for
    telemetry-latest. Not Phase 6b scope; **becomes relevant if §B's
    `region-wear-trends` aggregator (which joins `derived-sustainment`
    with `asset-telemetry-windows`) needs the windowed-input side
    exercised for its own verification.** If §B builds against the
    derived-sustainment side only and treats the windowed-input as a
    code-verified contributor, the fixture stays a tail item. If §B
    needs both sides hot, the fixture is the prerequisite.

## Future phases

**Distinct category from tracked follow-ups.** Follow-ups are code-level
placeholders or small forward-looking enhancements; future phases are
larger blocks of work with their own scope, their own dependencies, and
their own demonstration story. Listed here so a future reader does not
mistake them for "small things we forgot to finish."

### Fire/Detonation + barrel-life activation

Activates follow-up #4 (the dormant `wear.barrel` model). New work
spanning:

- the DIS sidecar (`dis_ingestor.py`): extend the PDU-type allowlist
  beyond Entity State to include Fire (type 2) and Detonation (type 3),
- a new Bloblang mapping (`sim-dis-mapping.yaml`): Fire/Detonation case
  emitting onto `raw-sensor-stream` (or a sibling topic) in a shape the
  prognostics engine can consume,
- the prognostics engine: route the round-fired event through
  `accumulators.record_round_fired()` — that single call activates the
  dormant model end-to-end.

**Blocked on**: customer ammo / shot / round-fired message inventory.
Before this phase can be scoped, we need to know what the customer's
ammo message actually looks like — payload shape, timing semantics, what
counts as a "round" vs. an "event," whether entity-id correlation
matches DIS. Without that input the DIS-side work would be built against
an LLM-reconstructed sample — repeating the customer-overlay / Sensor mistake
(see `feedback_artifact_provenance` — "wire outranks schema").

**What this phase would deliver**: an active `wear.barrel` model
emitting on `derived-sustainment`, a flight test asserting non-empty
barrel-life for a fired entity, and the same `origin = ORIGIN_DERIVED`
`ConstrainingFactor` treatment that Phase 5 step 2 established for the
kinematics-only wear models. `test_38_prognostics_barrel_life_dormant`
gets inverted to `_active`.

## Phase 5 close note

For the demo narrative when stakeholders are walked through it.

**Phase 5 closed at step 2.** The demo claims: a derivation engine is
wired end-to-end on the three kinematics-derivable wear models — track
(from cumulative distance), engine (from observed time), suspension
(from terrain integral). Kinematic-only assets that previously showed an
empty prognostics panel now produce live `derived-sustainment` events;
`logistics-fusion-service` consumes them through the new
`fusion-service-derived` subscription, the `_eval_wear` percent-aware
branch evaluates them, and the resulting `asset-logistics-status`
updates carry `ConstrainingFactor`s stamped `origin = ORIGIN_DERIVED`
structurally — the contract that keeps measured-vs-derived visible to
any downstream consumer. The demo does **not** claim that the derived
values are accurate, that engine-hours reflects engine-on time (it is
observed time — a deliberate overestimate, named in ADR-0020), that
barrel-life is active (the model is built but dormant pending
Fire/Detonation PDU ingestion — promoted to its own future phase,
blocked on customer ammo-message inventory), or that the coefficient
values represent real platform life (defaults in `coefficients.py` are
honest-authored at order-of-magnitude reasonable values; the demo
overrides via `PROGNOSTICS_*` env vars in
`docker-compose.override.yml` to compressed values so a few-km /
few-minute scenario actually crosses thresholds — *the compressed
values are sized so the demo shows the engine working, not estimates
of real platform life*). Severity stamps on derived factors are real
arithmetic against actual kinematics; they are not validated
assessments of asset condition. The `ORIGIN_DERIVED` marker is the
contract that protects the distinction at every consumer boundary
downstream.
