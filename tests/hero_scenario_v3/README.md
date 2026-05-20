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
   `state.rounds_fired == 0`. The wiring that closes the dormancy —
   ingesting real fire events and calling
   `prognostics.accumulators.record_round_fired()` — is its own future
   phase, tracked as **#4b** below. #4 (the dormant prognostic) and
   #4b (the gating fire-event-ingestion wiring) are a pair: #4 activates
   when #4b lands. `test_38_prognostics_barrel_life_dormant` asserts the
   dormancy on every run so a clean test suite cannot hide it.

   **Recipe-revision note (2026-05-20) — a dropped interim path.**
   Between Phase 6 close and the engagement-worthiness phase, an interim
   recipe explored deriving barrel-life from the customer's
   `StrikeCapabilityMessage` feed by *delta synthesis*: track per-(asset,
   store) Ammo across consecutive snapshots and synthesize a
   `rounds_fired` count from each decrease. It went through three
   iterations (v1 single-source, v2 dual-source with `shot_msg`, v3
   delta-as-secondary). **All three are dropped.** The clarification
   that retired them: `StrikeCapabilityMessage`'s intended purpose is
   *engagement-worthiness* ("can this asset still engage, given its
   remaining stores?"), not barrel-life. Barrel-life-as-prognostic has
   a cleaner architectural answer — direct fire-event ingestion (#4b) —
   that was already planned. Delta synthesis was inventing a
   stateful-tracking layer to reconstruct what a fire event reports
   directly: the wrong architectural answer to a problem the customer
   had not asked us to solve. The capability feed instead became the
   input to the **engagement-worthiness phase** (tracked-follow-up
   below in COP/consumers), which is the customer's actual ask. The
   barrel-life model stays exactly as Phase 5 left it — dormant,
   source-agnostic (`record_round_fired()` takes an int), waiting on
   #4b.
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
   views — FIDELITY follow-up (enhancement, honesty-neutral).** Phase
   4c removed `AssetSpawner` (the GLB-model renderer) when the simulator
   plumbing was deleted; the regional and HQ 3D maps now render every
   asset as a status-colored sphere (a "dome" from the top-down camera)
   — see `RegionalSustainmentPosture.tsx`'s `AssetMarker`. The
   `DdilNetworkLink` comm lines and `LogisticsHubNode` markers survived;
   the per-platform tank / radar / launcher / UGV silhouettes and the
   floating status badges did not.

   **Staged-GLB inventory (verified 2026-05-20):** three model files are
   already present in `frontend/public/models/` — `stryker.glb`,
   `himars.glb`, `ugv.glb` — but nothing loads them (`useGLTF` appears
   nowhere in `src`). They cover 3 of the 4 mock platform types; a
   radar / LTAMDS GLB is missing and must be sourced.

   **Implementation:** a `useGLTF` + `<Suspense>` renderer replacing
   `AssetMarker`; status color on an emissive base ring under each model
   rather than recoloring baked GLB materials. Covers the regional map,
   the HQ theater view, and the AssetDeepDive zoom-in.

   This is **enhancement** — it makes the demo prettier and does NOT
   change honesty. The separate question of WHERE the rendered asset
   list comes from (today a hardcoded mock) is the honesty follow-up
   **#23** — do not bundle the two; see #23 for the sequencing rationale.
   Eye-candy pass (2026-05-15) deliberately deferred this as "model
   fidelity," not "frame parity."

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

18. **`restate_hub.py` vs `hub_restate_projector.py` script divergence
    between published image and live runtime — image hygiene smell.**
    The published
    `ghcr.io/edgy-solutions/openddil/hub-restate-projector:latest`
    image's Dockerfile (`openddil-tactical-agents/hub/projector/
    Dockerfile`) bakes `hub_restate_projector.py` as the production
    entry. But `openddil-demo/docker-compose.yml` overrides the
    `restate-hub` service entrypoint to
    `["/opt/venv/bin/python", "/app/restate_hub.py"]` and bind-mounts
    `../openddil-tactical-agents/hub/restate_hub.py` over `/app/
    restate_hub.py` (lines ~735–744). So the image as published and
    the script that actually runs in compose are DIFFERENT files. The
    openddil-helm chart preserves this compose runtime behavior by
    mounting `restate_hub.py` from the bundle image's `agents/hub/`
    subtree at `/app/restate_hub.py` (see `openddil-helm/openddil-
    demo/templates/hub.yaml` restate-hub Deployment and the README's
    known-smells section).

    Compounding: `restate_hub.py` itself contains an "Enterprise Saga
    (ALCS API)" function (lines 63–81) that POSTs to
    `http://hq-alcs-api:8080/work-orders` — no such service exists in
    any compose or helm topology, so this code path is decorative
    narrative scaffolding for the Hero Demo story, not wired-up work.

    Visible consequence today: **none in compose** (bind-mount supplies
    the file; Restate's "Enterprise Saga" is never triggered in normal
    demo flow, so the dead ALCS endpoint is never called). **None in
    helm** (the bundle init-container supplies the file the same way).
    The smell becomes a real failure mode only if someone deploys
    `hub-restate-projector:latest` without the compose-bind-mount or
    the helm bundle-init pattern — the image alone runs
    `hub_restate_projector.py`, not the `restate_hub.py` that the demo
    narrative + docker-compose entrypoint assume.

    **Decision needed**: which script is canonical?

    **Resolution paths**:
      (a) **`hub_restate_projector.py` is canonical** (what the image
          bakes). Delete `restate_hub.py` from the repo; remove the
          docker-compose bind-mount + entrypoint override; remove the
          helm bundle-init copy of `agents/hub/restate_hub.py` (drop
          the `agents/` subtree from the bundle entirely if nothing
          else references it). The "Enterprise Saga (ALCS API)" code
          gets lost — recoverable from git history if the ALCS/EAGLE
          egress phase wants to revive it.
      (b) **`restate_hub.py` is canonical** (what compose actually
          runs). Update `openddil-tactical-agents/hub/projector/
          Dockerfile` to COPY `restate_hub.py` instead of (or
          alongside) `hub_restate_projector.py`; republish the image;
          remove the compose bind-mount + entrypoint override;
          remove the helm bundle-init `restate_hub.py` copy. Image
          and runtime converge on the script that actually demos.
      (c) **Both serve distinct purposes** (e.g. `hub_restate_projector
          .py` is the projector half, `restate_hub.py` is the saga
          half, both meant to run together via different processes).
          Document the intentional divergence in both files' headers
          and in the Dockerfile + compose service definitions. No
          code change; eliminate the smell by making the divergence
          explicit.

    **Pre-resolution tasks regardless of (a)/(b)/(c) choice**:
      * Read both files end-to-end and verify whether they implement
        the same surface area or distinct ones. Comment block at top
        of each currently doesn't make this clear.
      * Decide whether the "Enterprise Saga (ALCS API)" dead-endpoint
        code is keep-as-narrative-scaffolding-with-a-clarifying-
        comment OR delete-until-ALCS/EAGLE-egress-phase-arrives. Pairs
        with the broader ALCS/EAGLE-egress-phase scoping question.

    Discovered while writing the openddil-helm chart (the bundle init-
    container needed an explicit decision about which script to copy
    into the runtime). Logged here so it doesn't get rediscovered
    under deadline pressure; not blocking the helm work (chart
    preserves compose behavior) but worth resolving before the
    ALCS/EAGLE egress phase opens, since that phase will touch this
    same code surface.

19. **Engagement-worthiness via StrikeCapabilityMessage —
    `asset_capability_state` → `ConstrainingFactor`.** The customer's
    `StrikeCapabilityMessage` feed (a capability snapshot per asset:
    loaded stores, per-store Ammo, store category / location) drives a
    "can this asset still engage?" assessment that surfaces as an
    `AMMO_LOW` / `AMMO_EXHAUSTED` `ConstrainingFactor` on the COP. This
    is the customer's *actual* ask for this feed — see #4's
    recipe-revision note for why reading barrel-life out of the same
    feed was the wrong architecture. Built in three sub-phases:
      - **Sub-phase A — ingest (DONE).** Customer-overlay connect
        services land the AMQP feed on the `asset-capability-snapshot`
        Silver topic: `connect-strike-capability-amqp` (RabbitMQ
        `strike_capability_q` → `ingress-strike-capability-raw`), then
        `connect-strike-capability` (Bloblang normalize → Silver).
        Verified by `test_43_strike_capability_end_to_end`.
      - **Sub-phase E — project to DB (DONE).** A new projector
        `capability_state` handler upserts the Silver snapshot into the
        `asset_capability_state` Postgres table (PK `asset_id`,
        `capabilities` JSONB, `schema_version` / `mode`, origin
        provenance). Schema + migration + `electrify.sql` publication
        in `openddil-stack` (commit 8192bcc); handler + registry +
        `projector_config.yaml` mapping in `openddil-projector`
        (commit 033f9db). Verified by
        `test_44_strike_capability_projected_to_db`.
      - **Sub-phase F — engagement-worthiness factor (DONE).**
        `logistics-fusion-service` gained an `_eval_inventory` evaluator
        (paralleling `_eval_wear`): a new `on_capability_snapshot`
        Restate handler stores the latest capability snapshot per asset,
        `_eval_inventory` emits `AMMO_LOW` / `AMMO_EXHAUSTED`
        `ConstrainingFactor`s stamped `origin = ORIGIN_DERIVED` on the
        existing `asset-logistics-status` output, and `_eval_staleness`
        was extended so a capability-only asset (no DIS / sustainment
        telemetry) is not false-flagged "no telemetry". A
        `fusion-service-capability-*` Restate subscription per edge
        feeds the handler. Verified by
        `test_45_strike_capability_engagement_worthiness` (AMQP → Bronze
        → Silver → fusion → projector → `asset_logistics_status`) plus
        10 `_eval_inventory` unit tests in the fusion service's
        `test_rules`.
    **CLOSED — A + E + F all landed.** Sub-phase G (surfacing the factor
    on the COP UI) is separate frontend work, not part of this follow-up.
    This follow-up never closed #17 — `asset_capability_state` (per-asset
    loaded-store capability) is a distinct table from `inventory_items`
    (FOB inventory), and the per-FOB-vs-shared inventory decision in #17
    is orthogonal to it.

20. **Stale Phase-6b broker references in `_cm_helpers.py` — AUDITED
    AND FIXED (2026-05-20).** Phase 6b §A moved `asset-cm-state`,
    `tactical-events`, and `asset-logistics-status` off the per-edge
    brokers onto `redpanda-hq` (cm-service and logistics-fusion-service
    both target `redpanda-hq:19092`); the per-edge brokers keep empty
    topic-init-parity copies only. Three references in `_cm_helpers.py`
    still pointed at the old edge topology:
      - `KAFKA_BOOTSTRAP = "localhost:9093"` (redpanda-edge-01 OUTSIDE
        listener) — every `consume_topic_recent` call read an empty
        edge copy. **Fixed → `localhost:19093`** (redpanda-hq OUTSIDE).
      - `submit_cm_event_via_cli` passed `--brokers redpanda-edge:9092`;
        the bare `redpanda-edge` host has not resolved since the Phase
        6a rename to `redpanda-edge-0N`, so every CmEvent submit
        silently no-op'd (the CLI exits 0 without verifying delivery).
        **Fixed → `redpanda-edge-01:9092`** (cm-events is a per-edge
        topic).
      - `REDPANDA_SVC = "redpanda-edge"` — same dead bare name; the
        copy in `_helpers.py` was updated to `redpanda-edge-01` at
        rename time but this one drifted. **Fixed → `redpanda-edge-01`.**
    **Assertion-polarity finding:** all six affected tests (12, 13, 14,
    15, 16, 39) FAIL HONESTLY with the stale config — none passed
    spuriously. The two with absence-style assertions (test_15
    no-realert, test_16 resolved-alert) each guard the absence check
    behind an explicit presence check on the first consume, so a broken
    broker is caught before the vacuous assertion is reached. Good
    defensive design — worth preserving the pattern in new tests.
    **Verified post-fix:** tests 12 / 13 / 14 / 15 / 16 PASS. test_39
    had been silently SKIPping since Phase 6b (its
    `_consumer_group_stable` precondition was double-stale — dead
    `REDPANDA_SVC` *and* a pre-edge-suffix group name
    `fusion-service-derived`); both fixed, so it now runs — and reveals
    a genuine failure underneath, split out as #22.

21. **helm-test `connectivity.yaml` checks the wrong publication name.**
    `openddil-helm/openddil-demo/templates/tests/connectivity.yaml`'s
    `test-postgres-hq` pod asserts the Electric publication exists by
    querying `pg_publication WHERE pubname =
    'electric_publication_default'`. The publication created by
    `openddil-stack/electric/electrify.sql` is named
    `electric_publication` (no `_default` suffix). The check
    false-fails: `helm test` reports the postgres pod failed even when
    the publication is correctly in place. ONE-LINE FIX — change the
    pubname literal. Affects `helm test` only; chart install and the
    data path are unaffected. Already recorded in
    `openddil-helm/README.md`'s known-smells section; mirrored here so
    this canonical follow-up list is complete. Deliberately not fixed
    inline to avoid bumping the chart version mid-deploy-cycle — fold
    into the next natural chart change.

22. **test_39 prognostics→fusion integration — DIAGNOSED AND FIXED
    (2026-05-20).** With #20's broker + precondition fixes,
    `test_39_prognostics_to_fusion_integration` stopped SKIPping (it had
    SKIP'd unconditionally since Phase 6b); it then ran and failed
    consistently — "no asset-logistics-status updates for dis:1:1:9994".
    Root cause was NOT the prognostics pipeline: fusion was demonstrably
    emitting for the asset (cadenced revisions 11→25 in its logs, plus a
    live row in `asset_logistics_status`). The bug was in the test
    consumer — `consume_asset_logistics_updates` passed `max_records=50`
    to `consume_topic_recent`, which reads FORWARD from
    `high - per_partition_tail`. On the post-Phase-6b consolidated hq
    topic (8 partitions, ~86k records) 50 records only covers the OLD
    end of the tail window; the asset's recent emission near `high` is
    never reached. Fixed by raising `max_records` to 4000 so the full
    `per_partition_tail x partition_count` window drains. test_39 now
    PASSES (12 updates for `dis:1:1:9994`, `wear.suspension` factor with
    `origin = ORIGIN_DERIVED`). **All six tests in #20's set
    (12, 13, 14, 15, 16, 39) now confirmed passing.**

23. **Drive the regional 3D view's asset list from the real pipeline —
    HONESTY follow-up (never-was-real).** Split out of #10 along the
    fidelity-vs-honesty axis. `RegionalSustainmentPosture.tsx` renders
    its 3D map from a hardcoded `DISCOVERED_FLEET` array (4 invented
    assets — LTAMDS-04, STRYKER-DE-09, HIMARS-ALPHA, GHOST-UGV-1 — with
    synthetic positions and statuses), `DEMO_MOCK = true`. This is the
    same fabricated-entity problem as the HQ theater map's `REGIONS`
    array (see the map-honesty scoping read): the *entities* don't exist
    in the pipeline, not merely their positions. RegionalApp ALREADY
    holds the real AOR asset list — the component header notes asset
    *selection* is driven by it — the 3D view simply doesn't use it for
    *rendering*. Fix: render from that real list (a
    `useFleetAssetsForRegion`-style subscription, the regional analog of
    `useFleetAssetsForEdge`), retiring `DISCOVERED_FLEET`. ADR-0017
    discipline applies.

    **Sequencing:** rides with the broader map-honesty phase (which
    scopes BOTH the HQ `TheaterReadinessPosture` and this regional view)
    and is gated on the route-A-vs-B decision — map with notional
    positions vs. abstract topology diagram — pending the DIS-position
    investigation. **Do NOT bundle with #10.** Different completion
    criteria, different discipline: the honesty fix can land first and
    render real assets as plain spheres (honest but visually weak —
    better than mock-but-visually-rich); #10's fidelity fix lands later
    when GLB sourcing is done. Bundling risks one blocking the other.
    For demo readiness the honesty fix is the higher priority —
    fabricated assets that don't match the rest of the demo are a
    stakeholder-question magnet; status-colored spheres at least don't
    claim to be tanks.

24. **DIS position layer is format-complete but wire-empty.** The
    per-asset position path is plumbed end to end — DIS Entity State PDU
    ECEF → `dis_ingestor` → `sim-dis-mapping` → `raw-sensor-stream` →
    projector `telemetry_latest` handler → `telemetry_latest_state
    .kinematics` (jsonb) → `electric_publication` → `HqApp`'s
    `useFleetAssets()`. But the values are empty: of 31 DIS rows in
    `telemetry_latest_state`, 29 carry ECEF `(0,0,0)` (proto3 omits the
    zero `value`s — only `unit` survives) and 2 are straight-line test
    artifacts — `dis:1:1:9994` at `x=5000` (test_39's terrain ramp) and
    `dis:1:1:1880` at `x=400`. `build_entity_state_pdu` defaults
    `location_ecef=(0,0,0)`; every DIS PDU in the demo is
    test-generated. `position.quality.source` is honestly stamped
    `POS_SRC_SIMULATED`, and the simulator service was removed in Phase
    4b — no live feed (newest non-test row is 2026-05-18). The only real
    DIS position source would be a VRForces / AFSim integration — the
    SAME dependency as #4b (fire-event ingestion). Also absent: any
    ECEF→WGS84 conversion utility (`wgs84` is null on every row). Net: a
    future reader must NOT read "we have asset positions" off the schema
    — the schema is complete, the wire is zero. Surfaced during the HQ
    map-honesty scoping. Real customer-asset geography does exist on a
    different feed — see #25.

25. **Customer Unit-message WGS84 is real and already lifted to Silver
    — the viable A-derived-partial source for map honesty.** The
    investigation prompted as "revisit the dropped customer
    `parentLat/parentLon`" found the premise slightly mis-aimed, and a
    better answer underneath:
      - `parentLat/parentLon` lives on the customer-overlay proprietary feed's
        **Sensor** message (a fixed sensor ARRAY). The whole Sensor
        message is deliberately dropped at Silver
        (`proprietary-mapping.yaml:56-60`, `deleted()`) — OpenDDIL
        Silver has no sensor-coverage type and OpenDDIL is a logistics
        COP. That is a data-model scoping decision, NOT "nothing needed
        it yet" — so it is NOT cheaply revisitable; reviving it means
        modeling fixed sensor installations as first-class entities
        (Large). Do not do that for the map.
      - The same feed's **Unit** message (a mobile asset) carries
        top-level `lat`/`lon`/`alt`, and `proprietary-mapping.yaml:125-
        136` ALREADY lifts them into Silver
        `kinematics.position.wgs84.{lat,lon,alt}` (unit `deg` —
        LLM-inferred label per `units.md`, values real-captured from
        live wire traffic). When the customer-overlay proprietary overlay runs,
        customer Unit assets land in
        `telemetry_latest_state.kinematics.position.wgs84` with real
        decimal-degree positions — no ECEF→WGS84 conversion needed (that
        is a DIS-only problem, #24). Lifting work: **zero, already
        done.** Frontend consumption: Small.
    So **A-derived-partial is viable now** for customer Unit assets,
    gated only on the customer-overlay proprietary overlay running (it is not
    in the current running stack) and the customer emitting Unit
    messages. Caveats: (1) the customer-overlay overlay is single-edge
    (edge-01), so real positions cover edge-01 customer assets only —
    edge-02 / edge-03 stay DIS-only zeros (#24); (2) customer lat/lon is
    private-bundle data — fine as runtime DB data the OSS frontend
    reads, but absent from the public example bundle. Cross-ref #24;
    feeds the route-A-vs-B map-honesty decision.

## Future phases

**Distinct category from tracked follow-ups.** Follow-ups are code-level
placeholders or small forward-looking enhancements; future phases are
larger blocks of work with their own scope, their own dependencies, and
their own demonstration story. Listed here so a future reader does not
mistake them for "small things we forgot to finish."

### #4b — Fire-event ingestion + barrel-life activation (deferred)

The gating dependency for tracked-follow-up #4. The Phase 5 barrel-life
model is built and dormant; this phase delivers the fire-event input
that activates it. #4 (dormant prognostic) and #4b (this phase) are a
pair — #4 flips to active when #4b lands.

**The work, source-agnostic:**
- Ingest fire events from whatever source materializes (see candidates
  below). Each fire event is a discrete record: one weapon discharge.
- Route each event through `prognostics.accumulators.record_round_fired()`
  — the one-line activation. The model takes a `rounds_fired` int and
  does not care about the source.
- Invert `test_38_prognostics_barrel_life_dormant` to `_active`.
- Surface `wear.barrel` (one `platformChartConfig.ts` line per
  barrel-bearing platform variant).

**Cadence concern (distinct from the engagement-worthiness phase):**
fire-event ingestion is *event-driven* — each event is a discrete
`record_round_fired()` call — so the question is not refresh-rate but
*event-completeness*: a dropped fire event is a permanently-undercounted
barrel. Whatever source is chosen needs at-least-once delivery for the
fire-event stream.

**Candidate fire-event sources (none materialized yet):**
1. **DIS Fire (PDU type 2) / Detonation (PDU type 3)** — would extend
   the OSS DIS path. `dis_ingestor.py:312-318` already *counts* both
   via Prometheus but drops them before Kafka (observability exists,
   extraction does not). Needs a real DIS fire-event source, i.e. a
   VRForces or AFSim integration.
2. **Customer `shot_msg`** — a per-shot event message from the same
   producer that emits `StrikeCapabilityMessage`, on routing key
   `customer_overlay_shot_msg` / queue `shot_q`. Schema LLM-reconstructed at
   `openddil-customer-bundle-customer-overlay/schemas/shot_message.schema.json`
   (no wire sample yet — higher provenance risk than the wire-confirmed
   `StrikeCapabilityMessage`). Carries `salvo_size` = rounds fired,
   directly. If a wire sample arrives, this is the lower-effort source.

**Activation trigger**: a fire-event source becomes available — a
VRForces/AFSim integration, or a wire-confirmed `shot_msg` feed.

**A dropped non-answer, recorded so it isn't re-attempted:**
deriving barrel-life from `StrikeCapabilityMessage` Ammo *deltas*
(track per-store Ammo, synthesize a round-fired count from each
decrease). An interim recipe iterated this three times (v1/v2/v3)
before it was retired. It was the wrong architecture: a stateful
delta-tracking layer reconstructing what a fire event reports
directly, solving a problem (`StrikeCapabilityMessage` → barrel-life)
the customer never posed. `StrikeCapabilityMessage`'s actual purpose
is engagement-worthiness — see the tracked follow-up in COP/consumers
below. Do not revive delta synthesis; wait for a real fire-event
source.

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
fire-event ingestion — tracked as follow-up #4, gated on phase #4b
which delivers a real fire-event source. An interim post-Phase-5
recipe explored deriving barrel-life from `StrikeCapabilityMessage`
Ammo deltas; that path was dropped as the wrong architecture — see
#4's recipe-revision note. The `StrikeCapabilityMessage` capability
feed instead drives the separate engagement-worthiness work, tracked
as follow-up #19),
or that the coefficient
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
