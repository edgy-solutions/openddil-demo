# MRAD Maintainer View — Rollout Guide

Status: **Phases A + B + C shipped.** End-to-end live pending image rebuild
+ Atlas migration apply + helm upgrade.

## What's deployed where

### Phase A — Frontend (openddil-demo)
Commit: `1b6f345` on master.
- `SensorArrayView` refactored: `SensorArrayConfig.layers` drives drill
  depth + per-layer cols/rows/naming/sizing.
- New `MRAD_CONFIG` (single face, MRAD-themed layer names).
- `DiagnosticCanvas` routes any `platform_variant` in `MRAD_VARIANTS`
  (`MRAD_Sensor`, `MRAD_Radar`, `MRAD_Interceptor`, `MRAD2_radar`) to
  `SensorArrayView` with `MRAD_CONFIG`.
- `MaintainerApp` threads `assetId` so seeded telemetry is per-asset.
- Seeded RNG (mulberry32 over `hashStringToSeed(assetId|depth)`)
  makes every asset's element pattern stable AND independent.

### Phase B — Sim service (openddil-mrad-sim)
New repo. Tests: `8/8` passing.
- `aiokafka`-only Python service. Consumes `telemetry-latest-state`
  on every edge cluster, filters `platform_variant ∈ mrad_variants`,
  builds an in-memory roster.
- Tick loop generates one whole-asset envelope per asset per tick
  (default 30s), publishes to `mrad-element-telemetry` on HQ broker.
- Element ids match `SensorArrayView.generateElements()` exactly —
  locked in by `test_element_id_format_matches_frontend`.
- Determinism + per-asset independence enforced by tests.

### Phase C — Wiring (this commit)
- Atlas migration `20260613000000_phase9_mrad_element_telemetry.sql`
  + matching `schema.hcl` table block.
- Projector handler `mrad_element_telemetry.py` registered in
  `handlers/__init__.py` + topic mapping in
  `projector_config.yaml`.
- Frontend hook `useMradElementTelemetry(assetId)` returns a
  `LiveElementTelemetry` map keyed by `element_id`.
- `DiagnosticCanvas` wires the hook through to `SensorArrayView`
  on the MRAD branch — live values override seeded fallback.
- Helm chart bumped to `0.1.25`:
  - New `mradSim.*` values block (image + config).
  - New `templates/mrad-sim.yaml` (ConfigMap + Deployment, gated by
    `mradSim.enabled`).
  - `mrad-element-telemetry` topic added to topic-init.
  - Mirror script knows about the `mrad-sim:latest` image and the
    `mradSim.image.digest` values path.

## Rollout sequence

Each step is idempotent except the migration; run in order.

### 1. Build + push the mrad-sim image

```bash
# From the openddil-mrad-sim repo:
docker build -t ghcr.io/edgy-solutions/openddil/mrad-sim:latest .
docker push ghcr.io/edgy-solutions/openddil/mrad-sim:latest
```

If your CI builds on push, just push the master branch instead.

### 2. Apply the migration on the running HQ postgres

```bash
NS=drone-spotter-sandbox
kubectl -n $NS exec -i sts/openddil-postgres-hq -- \
  psql -U openddil -d openddil < \
  openddil-stack/schema/migrations/20260613000000_phase9_mrad_element_telemetry.sql
```

Or if you have Atlas wired up:

```bash
cd openddil-stack/schema
atlas migrate apply --env postgres-hq
```

### 3. Re-mirror to pick up the new image digest

```bash
pwsh openddil-helm/scripts/mirror-to-artifactory.ps1 -RepoBase artifactory.example/openddil
```

This writes `mradSim.image.digest` into `values-pinned.yaml` and the
new entry in the chart inventory will pull/tag the mrad-sim image.

### 4. Roll OSS forward to chart 0.1.25

```bash
helm upgrade openddil openddil-demo -n $NS \
    -f defaults.yaml -f values-pinned.yaml \
    --set persistence.redpandaUseEmptyDir=true \
    --set persistence.restateUseEmptyDir=true
```

The upgrade renders:
- ConfigMap `openddil-mrad-sim-config` with the sim config
- Deployment `openddil-mrad-sim` with the mounted ConfigMap
- topic-init Job creates `mrad-element-telemetry`
- projector pods pick up the new `projector_config.yaml` (hot reload
  is not in scope — they roll on the upgrade)

### 5. Verify

```bash
# Sim is up + consuming
kubectl -n $NS logs deploy/openddil-mrad-sim --tail=30

# Look for: "discovered MRAD asset demo:*_MRAD2_radar (variant=MRAD2_radar, roster=N)"
# and once per tick: "tick X: published N asset snapshot(s) of 115 elements each"

# Topic has data
kubectl -n $NS exec sts/openddil-redpanda-hq -- \
  rpk topic describe mrad-element-telemetry -p

# Projector consumed
kubectl -n $NS exec sts/openddil-redpanda-hq -- \
  rpk group describe projector-mrad-element-telemetry

# Postgres has rows
kubectl -n $NS exec sts/openddil-postgres-hq -- \
  psql -U openddil -d openddil -c \
  "SELECT asset_id, jsonb_array_length(elements) AS n_elems, observed_at FROM mrad_element_telemetry;"
```

### 6. Verify the UI

In the MaintainerApp asset picker, select an MRAD asset (e.g.
`demo:***_MRAD2_radar`). The `SensorArrayView` should render
with the MRAD_CONFIG layout (1 PRIMARY APERTURE face, drill through
BACKPLANE → PROCESSOR BANK → GAN MMIC CHIP). Element colors should
match what the sim generated for that asset (DEGRADED / CRITICAL
where the seed lands above the band).

In DevTools, the `DiagnosticCanvas` component should show
`mradLive` non-undefined for MRAD-class selections. If `mradLive` is
undefined but the topic has data, the issue is either:
- ElectricSQL shape not synced (check the `mrad_element_telemetry`
  shape in the ElectricSQL admin), or
- The hook's `where` clause doesn't match (verify the exact
  `asset_id` string between the UI's selection and what's in the
  postgres row).

If `mradLive` IS defined but elements don't change colors, the
element id format may have drifted — see the test
`test_element_id_format_matches_frontend` in `openddil-mrad-sim`
for the canonical format.

## Disabling the sim

To run a demo WITHOUT the sim service (the view falls back to seeded
RNG synthesis):

```bash
helm upgrade openddil openddil-demo -n $NS \
    -f defaults.yaml -f values-pinned.yaml \
    --set mradSim.enabled=false ...
```

Or simply don't apply the migration / build the image — the projector
mapping is harmless if the topic has no producer, and the frontend
hook returns `undefined` cleanly.

## Tuning

To change the MRAD layout — different drill depth, different
cols/rows per layer, different layer names — update BOTH:

1. Frontend `MRAD_CONFIG.layers` in
   `openddil-demo/frontend/src/components/SensorArrayView.tsx`
2. Sim config `mradSim.config.layers` in
   `openddil-helm/openddil-demo/values.yaml` (or via `--set`)

They must agree on cardinality + element id format. The sim's tests
will fail if you skew the `prefix` between them in a way that breaks
the regex; the frontend silently falls back to seeded RNG for any
element id that doesn't match.

## What's NOT done

- Operator UI to tune the MRAD layout at runtime — config is YAML +
  helm-`--set` only.
- Per-element history table for trending — only the latest snapshot
  is persisted. Adding a history table would be one more projector
  handler + one more migration.
- `operational_state` from telemetry-latest-state is not yet plumbed
  into the sim's `degraded` flag — the sim currently always passes
  `degraded=False`. Wiring this is one more telemetry-latest-state
  consumer pass in `mrad_sim/main.py`'s tick loop.
