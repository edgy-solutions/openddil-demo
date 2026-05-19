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

4. **Barrel-life is built but dormant pending round-fired input wiring.**
   The model has the shape and passes unit tests; `_derive_barrel_life`
   correctly returns `None` while `state.rounds_fired == 0`. The wiring
   side of this — a new Bronze→Silver mapping that produces round-fired
   events, plus the `prognostics.accumulators.record_round_fired()` call
   — is **scoped as a separate future phase**, not a Phase 5 tail; see
   [Future phases](#future-phases) below. The follow-up here is the
   *code-level placeholder* that keeps the dormancy visible to future
   readers; the future phase is the work that closes the dormancy.
   `test_38_prognostics_barrel_life_dormant` asserts the dormancy on
   every run so a clean test suite cannot hide it.

   **Source-path note (post-Phase-5 update):** the original framing
   assumed DIS Fire/Detonation PDU ingestion as the input. Customer
   inventory came back with only `StrikeCapabilityMessage` (a *capability
   snapshot* carrying current Ammo counts per store — not an event
   stream). Round-fired events will therefore be synthesized from
   per-(asset, store-location) Ammo *deltas* between consecutive
   snapshots. The DIS Fire/Detonation PDU path is **deferred** to a
   future VRForces/AFSim integration phase (no real DIS Fire feed exists
   today). The model itself is source-agnostic — it takes a `rounds_fired`
   int and doesn't care whether the int came from event-counting or
   delta-synthesis. See the two future-phase entries below for the
   activation path and the deferred-DIS path respectively.
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
    §B (now closed) chose to build `region-wear-trends` against
    `derived-sustainment` only, leaving `asset-telemetry-windows` wired
    in the fan-in envelope as a DEBUG no-op in the aggregator's
    dispatcher. **This follow-up is STILL OPEN** — the windowed-input
    end-to-end exercise didn't get done in §B and remains the gap
    between "stamping verified in code" and "stamping verified on the
    wire" for the `WindowedTelemetry` path. Closing this needs a
    synthetic feed that pushes enough samples per edge to trigger
    faust-edge's sustainment-window flushing (DIS-only traffic doesn't),
    so both `test_42_windowed_emission_per_edge` (positive + negative
    isolation on `asset_telemetry_windows`) and a future test_47-style
    region-wear-trends-full-join check can be real assertions instead
    of code-only ones. Not §C scope either; lives outside Phase 6.

12. **Multi-region scaling beyond 2 regions.** ADR-0024 documents the
    multi-cluster Faust pattern §B implemented; one corollary that
    didn't bind at 2 regions but binds at scale: **each region's hq
    source App subscribes to the shared hq topics (`asset-cm-state`,
    `asset-logistics-status`) and filters by `region_id` at the source
    side.** That's O(regions) consumers each receiving every message
    on the shared topics. At 2-3 regions this is fine — the per-region
    Faust App consumer overhead is cheap and the shared topic volume
    is bounded by the per-asset event rate, not multiplied by region
    count. At 10+ regions the duplicate-reads cost becomes meaningful:
    every cm-service emit fans out to N consumers, each doing a
    JSON parse + region-id check + drop or wrap. **Three mitigations
    if the scaling pressure arrives:** (a) push the partitioning
    upstream — have cm-service / fusion produce per-region partitions
    keyed by region_id, source Apps consume only their region's
    partitions; (b) per-region brokers (resolves ADR-0023's known
    simplification — regional aggregators consume their own region's
    broker exclusively, no shared-topic fan-out); (c) a per-shared-
    topic redpanda-connect splitter between cm-service/fusion and the
    fan-in topics, doing the region filter once and producing N
    region-specific topics. None of these is needed today; flagged so
    a future scaling review doesn't have to rediscover the trade-off.
    See ADR-0024's Cons section.

13. **test_44's fresh-entity-id pattern is the durable-Table fix; revisit
    if more §B-style aggregation tests get written.** faust-regional's
    `assets_latest` Table is changelog-replicated and survives test
    restarts. A test that asserts "asset_count incremented by 1" on a
    fixed entity_id passes once and fails on every re-run — the second
    run UPSERTs the existing entry, delta=0. test_44 uses a unix-time-
    derived entity_id in the 2100-2899 range to keep IDs unique within
    edge-02's range. Same trick will be needed for any future test
    that asserts "aggregator gained one new asset." Not a blocker on
    its own; capturing the pattern because the next test author will
    hit the same flake.

14. **Pre-§A region-unspecified residuals — CLEANED UP pre-§C.1, test_47
    locks the invariant.** Inventory at §C.1 build time: 2 rows each in
    `asset_cm_state` and `asset_logistics_status`, all for assets
    `dis:1:1:1820` and `dis:1:1:2820`. Both assets were registered with
    cm-service / fusion BEFORE §A's stamping fix landed; their Restate
    Virtual Object state was initialized with empty `edge_id`/`region_id`
    and never re-emitted because no subsequent state-transition observe
    triggered. Cleanup approach: send refresh DIS PDUs through the
    natural pipeline — `sensor-ingest -> dis-mapper -> raw-sensor-stream
    -> cm-service.observe()` triggers `_extract_origin` to repopulate
    `record.edge_id/region_id` from the inbound Provenance, then the
    natural emit path updates `asset-cm-state` (and fusion follows the
    same pattern for `asset-logistics-status`). Verified zero residuals
    post-cleanup. test_47 makes the cleanup permanent — asserts zero
    NULL/empty/'region-unspecified' rows in the rolled-up table AND in
    both per-asset flat-pool tables as a startup invariant. If new
    residuals ever appear, they'd indicate a new pre-§A-style stamping
    regression upstream; the test catches it before it can drift.

15. **Regional vs maintainer pulldown UX asymmetry — design constraint
    for §C.2/§C.3.** The §C.1 regional pulldown is visually unobtrusive
    (dev/demo infrastructure) and has NO animated transition between
    region scopes. The §C.2 maintainer pulldown will be visually
    prominent and §C.3 will add an animated transition between edge
    scopes. The discriminator: **animation has a production analog or
    it doesn't.** Regional officer in production is fixed-to-their-
    region by auth context — no switching, so no transition to animate.
    A maintainer in principle can physically travel between FOBs (a
    real operational shift); the "FOB transport" animation maps that
    real movement to a UI gesture. ADR-0023 §C.3 names this as the
    demo-narrative payoff. When §C.3 design conversation starts, this
    asymmetry is the design constraint that should be findable — don't
    let "we did animation for regional too" backslide into the design
    just because it'd be symmetric with maintainer; symmetry is the
    wrong shape here.

16. **Frontend deployment-proof discipline (rule family).** The
    frontend is an nginx-served static build (see comment in
    `docker-compose.override.yml`) — source-file edits do NOT
    propagate to the running container. Every sub-phase touching
    `openddil-demo/frontend/` must include `docker compose build
    frontend` + `docker compose up -d --force-recreate frontend` AND
    a deployment-proof grep of the served bundle to confirm the new
    code actually shipped. The principled version of the rule lives
    in ADR-0025 (build-pass deployment verification discipline).

    Five sharpenings have accumulated as the rule met reality across
    §C.1 / §C.2 / §C.3 / the post-Phase-6 polish pass. Each one
    closes a specific way deployment-proof can give a false-positive
    "shipped clean" signal:

    **(16.a) Bundle-hash refresh is the load-bearing build-success
    signal — not the absence of terminal errors.** `docker compose
    build frontend` and `docker compose up -d --force-recreate
    frontend` can return without surfacing build failures in the
    terminal — they push build errors into a `docker-desktop://
    dashboard/build/...` URL and exit cleanly. The next curl returns
    the OLD bundle (because the new image never built). To surface
    failures: use `docker compose build --progress=plain frontend`,
    which prints errors to stdout instead of the dashboard. To detect
    a silent failure: compare bundle hash before/after rebuild —
    unchanged hash means the build silently failed regardless of
    what the terminal said. Caught live during the post-Phase-6
    polish pass: ~40-minute window where the EdgePulldown
    cyan-dialback commit and three follow-up commits' bundles never
    deployed because of JSX-comment syntax errors that buildx
    swallowed.

    **(16.b) JSX comments at the top of a `return (...)` body are
    syntactically invalid — two siblings without a parent.** Writing
    `return ( {/* comment */} <div>...</div> )` produces TS1005 /
    TS2657 build errors ("JSX expressions must have one parent
    element"). Rationale comments either go inside the root element
    (`<div>{/* comment */}<children/></div>`) or as JS-style block
    comments BEFORE the return statement (`/* comment */ return (
    <div>...</div> )`). Caught and adapted during polish-pass; small
    enough that this lives here rather than as its own working-style
    note.

    **(16.c) Grep target must be a JSX string literal, NOT a JS
    identifier.** Production bundles (Vite + minification) do not
    preserve function names — `useFleetAssetsForEdge` minifies to a
    single-letter symbol, grep returns nothing, deployment proof
    fails even when code shipped correctly. Only JSX string
    literals and other user-visible strings survive minification.
    The §C.2 recipe originally locked `useFleetAssetsForEdge` as the
    proof target and the cycle-1 deploy-proof returned empty until
    we discovered the minification effect. The right targets for
    §C.2 deployment proof:
      - Present post-§C.2 (any is unambiguous proof):
          `"no edges observed yet"` (EdgePulldown cold-state)
          `"only edge observed"` (single-edge affirmative display)
          `"no assets in scope"` (Header asset picker, replaces
                                    pre-§C.2 `"no assets in pipeline"`)
      - Absent post-§C.2 (regression check that OLD bundle is gone):
          `"no assets in pipeline"` (Header pre-§C.2 cold-state copy)

    **(16.d) Pin TWO grep targets — one positive, one negative.**
    Positive proves new code shipped; negative proves prior version
    isn't being served from cache / a stale CDN / a concatenated
    bundle. Either alone can be defeated by edge cases (partial
    sourcemap leaks, bundler quirks, layered builds). The two-target
    pattern is what catches the failure mode where positive grep
    succeeds against a bundle that ALSO still has the old code
    bundled in beside it.

    **(16.e) CSS minifier strips identity filter values.** Same
    lesson family extended to CSS animation values. `filter:
    blur(0)` minifies to `blur()` (invalid CSS, empty parens);
    `brightness(1)` minifies to `brightness()` (also invalid). Empty-
    paren filter functions are ignored by the browser; the keyframe
    silently misses its endpoint state and the animation snaps
    instead of interpolating. Caught live during §C.3 cycle 3.
      - Wrong:    `filter: blur(0) brightness(1)`
      - Right:    `filter: blur(0.1px) brightness(1.001)`
    Non-identity-but-imperceptible endpoint values survive
    minification AND keep the filter-chain shape consistent across
    all keyframes so function-by-function interpolation works.
    Deployment-proof rule applies to CSS bundles too: grep the
    CSS bundle keyframe for the values you wrote and confirm they
    survived.

    **(16.f) Tailwind v4's content scanner reads JS comments.** When
    a class-name-shaped token appears in a JS-style comment (e.g., a
    rationale comment explaining "the prior `min-h-[150px]` reservation
    was wrong"), Tailwind's scanner picks it up and bakes the
    utility CSS into the bundle even though no JSX element renders
    with it. Deployment-proof negative grep for a "removed" class
    can false-positive if the comment still references the literal
    token. Either remove the token from source comments OR phrase
    the rationale without using the class-name shape (e.g.,
    "min-height-pixel-150 reservation"). Caught live during
    post-Phase-6 polish-pass deployment proof.

    **The unifying principle**: production bundles are NOT the
    source. Minifiers, scanners, and tree-shakers transform source
    in ways that defeat naive deployment proofs. Verify with values
    that actually ship, in the form they actually ship (string
    literals, post-minification keyframe values, etc.), against the
    bundle that's actually served. When in doubt, hash-compare the
    bundle file across the rebuild — that's the cheapest unambiguous
    "did the deploy happen" signal.

17. **Inventory edge-scoping decision pending — visible discrepancy on
    the maintainer view until decided.** §C.2 scoped the maintainer
    view's asset picker per edge, but the Inventory panel (subscribed
    to `inventory_items` directly via `useShape`) stays UNFILTERED
    regardless of edge scope. A maintainer at `?edge=edge-02` sees
    their scoped asset picker but the FOB inventory shows all FOBs'
    items. This is honest in the commit narrative; it's an unresolved
    structural question, not a §C.2 bug.

    **Decision needed**: is `inventory_items` per-FOB (each FOB has
    its own inventory) or logistics-shared (a single fleet-wide
    inventory)? Both are defensible deployment models; the answer
    depends on the operational story the project intends.

    **Resolution paths**:
      (a) If per-FOB → add `edge_id` column to `inventory_items` in
          `openddil-stack/schema/schema.hcl`; add a `useInventoryFor-
          Edge(edgeId)` hook mirroring `useFleetAssetsForEdge`;
          update Inventory component to consume the scoped hook on
          the maintainer view (HQ / regional views may stay
          unfiltered). Atlas migration + frontend rewire. Estimated
          size: similar to §C.2's hook addition (~0.2× §C.1).
          STILL PENDING.
      (b) If logistics-shared → document why in
          `openddil-stack/schema/schema.hcl` near the
          `inventory_items` table (one-paragraph comment naming the
          deployment model). No code change required; the visible
          unfiltered behavior is correct.
          STILL PENDING.
      (c) **IMPLEMENTED — §C.2 follow-up commit.** Replace the
          hardcoded mock-fallback (`Coolant Pumps` / `T/R Modules`
          rows that rendered whenever `inventory_items` had zero rows)
          with an honest empty-state: "No FOB inventory data —
          inventory_items table not yet populated. Per follow-up #17."
          Also gates the rose stale-cached banner on `hasCachedData` —
          banner is meaningful when there's real data going stale,
          misleading when there's no real data at all. Pre-§C.2
          combination of mock-fallback + stale-banner read as "real
          data that's gone wrong" when it was actually "feature not
          built yet." Same family as ADR-0017's no-orphan-mocks rule,
          applied to the empty-state path. Caught during §C.2's
          maintainer-view eyeball walkthrough. Does NOT preempt the
          (a)-vs-(b) decision — it just stops misleading users while
          the question stays open.

    **Until (a) or (b) decides**, the maintainer view's Inventory
    panel shows the honest empty-state regardless of edge scope. Not
    a blocker; flagged so the per-FOB-vs-shared question doesn't
    get rediscovered under deadline pressure. Same shape as #11
    (sustainment-data fixture) and #14 (region-unspecified
    residuals) — name the decision, name the resolution paths, name
    the visible-during-deferred consequence.

## Future phases

**Distinct category from tracked follow-ups.** Follow-ups are code-level
placeholders or small forward-looking enhancements; future phases are
larger blocks of work with their own scope, their own dependencies, and
their own demonstration story. Listed here so a future reader does not
mistake them for "small things we forgot to finish."

### Capability-snapshot delta wiring + barrel-life activation

Activates follow-up #4 (the dormant `wear.barrel` model) via the
customer's actual feed shape — the `StrikeCapabilityMessage` capability
snapshot (carries per-store Ammo counts on a stable cadence). This is
the **first** of two phases that follow-up #4 spawned; the second is
the deferred DIS Fire/Detonation path below.

New work spanning:

- the customer overlay (`openddil-customer-bundle-customer-overlay/`): new
  Bronze→Silver Bloblang mapping that lifts `StrikeCapabilityMessage`
  into an intermediate `AssetCapabilitySnapshot` Silver topic. Schema
  for `StrikeCapabilityMessage` lives in
  `openddil-customer-bundle-customer-overlay/schemas/strike_capability_message
  .schema.json` (LLM reconstruction; treat as hypothesis, verify against
  wire — same discipline as `sensor_message.schema.json`),
- a new stateful delta tracker (faust agent or Bloblang processor) that
  holds per-(`asset_id`, `store_location`) last-seen Ammo, emits a
  `rounds_fired_delta` event per snapshot on Ammo-decrease,
- the prognostics engine: subscribe to the delta stream, route each
  delta of N through N calls to `accumulators.record_round_fired()` —
  that activation flips `_derive_barrel_life` from `None` to a populated
  `WearState`.

**Pre-recipe gate (provenance discipline)**: `StrikeCapabilityMessage`
schema is currently an LLM reconstruction from the customer's producer
code, NOT a wire-verified contract. Same risk class as the original
`sensor_message.schema.json` mistake (`feedback_artifact_provenance` —
"wire outranks schema"). Before recipe-pass, confirm via wire capture:

1. **Emission cadence** — stable interval (every N seconds regardless
   of change) vs only-on-change. The delta tracker design simplifies
   meaningfully if every message *is* an Ammo-decrease event.
2. **Field shapes on the wire vs the LLM schema** — repeat the
   sensor-message-style falsification check (units presence, scalar vs
   array, etc.) before committing to the Bloblang shape.
3. **Cold-start / reload / restart semantics** — first-seen-Ammo treated
   as baseline (no synthesis)? Ammo *increase* between messages (reload)
   handled as silent re-baseline? Edge restart with cold RocksDB —
   re-baseline from next snapshot? These are aggregator design points,
   not wire questions, but they need decisions at recipe time.

**What this phase would deliver**: an active `wear.barrel` model
emitting on `derived-sustainment` for assets whose ammo decreases over
time, a flight test asserting non-empty barrel-life after a synthesized
fire sequence, and the same `origin = ORIGIN_DERIVED` `ConstrainingFactor`
treatment that Phase 5 step 2 established for the kinematics-only wear
models. `test_38_prognostics_barrel_life_dormant` gets inverted to
`_active`.

### DIS Fire/Detonation PDU ingestion (deferred — VRForces/AFSim phase)

The original framing for follow-up #4 assumed the customer would emit
real DIS Fire (PDU type 2) and Detonation (PDU type 3) PDUs. Customer
inventory came back with only `StrikeCapabilityMessage` (handled by the
phase above). No DIS Fire/Detonation feed exists in the current customer
stack. This phase is **deferred** until a VRForces or AFSim integration
phase introduces a real DIS fire-event source.

Work this phase would still do, if/when activated:

- DIS sidecar (`dis_ingestor.py`): extend the PDU-type allowlist beyond
  Entity State to include Fire (type 2) and Detonation (type 3). Today
  the sidecar *counts* both via Prometheus (`dis_ingestor.py:312-318`)
  but drops them before Kafka — observability exists, extraction does
  not.
- New Bloblang case for Fire/Detonation in `sim-dis-mapping.yaml`,
  emitting onto `raw-sensor-stream` (or a sibling topic) in a shape the
  prognostics engine can consume.
- The prognostics engine: route the round-fired event through
  `accumulators.record_round_fired()` — the same one-line activation as
  the capability-snapshot path above.

**Why this stays parked, not merged into the capability-snapshot phase**:
DIS Fire/Detonation PDUs are *event* shapes (timestamped, entity-paired,
event-id-bearing) and would extend the OSS DIS path, not the customer
overlay. Merging the two would mix OSS work with customer-overlay work
in one phase. Keeping them split lets the capability-snapshot phase
ship cleanly inside the customer overlay, and the DIS-path phase can
be a clean OSS extension when VRForces/AFSim lands.

**Activation trigger**: a VRForces or AFSim integration phase introduces
a real DIS Fire/Detonation feed (or the customer's source code is
extended to emit them).

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
round-fired input wiring — split post-Phase-5 into two future phases:
capability-snapshot delta wiring against the customer's actual
`StrikeCapabilityMessage` feed, and a deferred DIS Fire/Detonation path
that activates if/when a VRForces or AFSim integration introduces a
real DIS fire-event source), or that the coefficient
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
