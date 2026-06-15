# Logistics-Sim / Maintainer 3D View — Rollout Guide

> Renamed from `mrad-rollout.md` 2026-06-13 along with the sim itself
> (`openddil-mrad-sim` → `openddil-logistics-sim`, multi-profile,
> upstream `operational_state` + `tx`/`rx` honored). MRAD ships as the
> first asset profile; LTAMDS / Patriot land as additional entries in
> `asset_profiles[]` with no code change.

## What's deployed where

### Frontend (openddil-demo)
- `SensorArrayView` is fully config-driven (`SensorArrayConfig.layers`
  drives depth + per-layer cols/rows/naming/sizing). MRAD ships as
  `MRAD_CONFIG`; future arrays land as additional configs.
- `DiagnosticCanvas` routes any `platform_variant` in `MRAD_VARIANTS`
  to `SensorArrayView` with `MRAD_CONFIG`.
- `useAssetElementTelemetry(assetId)` returns `LiveElementTelemetry`
  (per-element `health` / `temp` / `load` / `txActive` / `rxActive`)
  + the asset-level `operational` mirror + `profileName`.
- `LiveElementTelemetry` now carries `txActive` / `rxActive` per
  element so the customer-sim's `actively_transmitting` /
  `actively_receiving` flags propagate straight through to the
  interrogation panel.

### Sim service (openddil-logistics-sim)
- Multi-profile via `asset_profiles[]`. First profile is MRAD.
- Discovers assets from `telemetry-latest-state` on every edge
  broker; tracks per-asset `AssetState` (`platform_variant`,
  `power_state`, `health_state`, `actively_transmitting`,
  `actively_receiving`).
- Tick loop translates `degraded_power_states` +
  `degraded_health_states` (configurable) + the both-tx-rx-off
  state-mismatch into the `degraded` flag passed to the element
  generator. Net effect: when the customer feed reports
  `POWER_STATE_MAINTENANCE` or `HEALTH_STATE_FAULT`, the per-
  element synthesis bumps into the DEGRADED / CRITICAL band so
  the maintainer 3D drill-down lights up red in lockstep.
- Per-element `tx_active` / `rx_active` on face T/R modules
  inherit the asset-level bits directly. Internal layers
  (backplane, processor, MMIC) default to both true (support
  electronics, not radios).
- `16/16` tests pass: cardinality, id format vs frontend,
  determinism, independence, bounds, tick advancement, degraded-
  band, `operational_state` plumbing (4 tests), tx/rx
  propagation (5 tests).

### Wiring
- Atlas migration `20260613000000_phase9_asset_element_telemetry.sql`
  + matching `schema.hcl` block. Table:
  `asset_element_telemetry (asset_id, platform_variant,
  profile_name, elements jsonb, operational jsonb, observed_at,
  edge_id, region_id, updated_at)`.
- Projector handler `asset_element_telemetry.py` + registry entry
  + topic mapping in `projector_config.yaml`.
- Helm chart `0.1.26`:
  - `logisticsSim.*` values block (image + multi-profile config).
  - `templates/logistics-sim.yaml` (ConfigMap + Deployment, gated
    by `logisticsSim.enabled`).
  - `asset-element-telemetry` topic in topic-init.
  - Mirror script knows about `logistics-sim:latest` and the
    `logisticsSim.image.digest` values path.

## Rollout sequence

**Standard 3-step deploy (mirror → OSS → overlay) covers everything.**
No new manual steps for the sim. The pieces below run automatically:

* `openddil-logistics-sim` push → GHA `docker-build` workflow rebuilds
  and publishes `ghcr.io/edgy-solutions/openddil/logistics-sim:latest`.
* `openddil-stack` push (this migration is already in the schema/
  migrations directory) → `repository_dispatch` to openddil-helm →
  helm rebuilds `runtime-bundle:latest` with the new migration baked
  in.
* `mirror-to-artifactory.ps1` → captures both new digests into
  `values-pinned.yaml` (the `logisticsSim.image.digest` field plus
  the runtime-bundle digest the schema-init Job reads).
* `helm upgrade` → projectors roll (new handler entry in
  projector_config.yaml), logistics-sim Deployment + ConfigMap are
  created, `postgres-schema-init` post-upgrade hook fires
  `atlas migrate apply` and the new `asset_element_telemetry` table
  appears in postgres-hq.

```bash
NS=drone-spotter-sandbox

# 1. Re-mirror (picks up logistics-sim image + new bundle digest)
pwsh openddil-helm/scripts/mirror-to-artifactory.ps1 -RepoBase artifactory.example/openddil

# 2. helm upgrade to chart 0.1.26
helm upgrade openddil openddil-demo -n $NS \
    -f defaults.yaml -f values-pinned.yaml \
    --set persistence.redpandaUseEmptyDir=true \
    --set persistence.restateUseEmptyDir=true

# 3. Overlay deploy (your normal flow)
bash deploy.sh
```

### When the manual path IS needed

If you're rolling out before CI has rebuilt the runtime-bundle (e.g.
schema migration was just pushed and `openddil-helm`'s bundle-rebuild
workflow hasn't completed yet), the schema-init Job will run against
an old bundle that doesn't have the new migration, and the new table
won't appear. Either:

* Wait for the openddil-helm bundle-rebuild workflow to finish before
  mirroring (check `gh run list` on openddil-helm; look for the most
  recent `Build and publish runtime-bundle image` run to be green
  AFTER the openddil-stack push that added the migration), or
* Apply the migration manually as a one-shot:
  ```bash
  kubectl -n $NS exec -i sts/openddil-postgres-hq -- \
    psql -U openddil -d openddil < \
    openddil-stack/schema/migrations/20260613000000_phase9_asset_element_telemetry.sql
  ```
  Atlas's migration table will pick up the manual apply on the next
  helm upgrade as already-applied.

## Verification

```bash
# Sim is up + consuming
kubectl -n $NS logs deploy/openddil-logistics-sim --tail=30
# Look for "discovered asset demo:*_MRAD2_radar variant=MRAD2_radar (roster=N)"
# and per tick "tick X: published N snapshot(s) (M degraded honoring upstream state)"

# Topic has data
kubectl -n $NS exec sts/openddil-redpanda-hq -- \
  rpk topic describe asset-element-telemetry -p

# Projector consumed
kubectl -n $NS exec sts/openddil-redpanda-hq -- \
  rpk group describe projector-asset-element-telemetry

# Postgres has rows + per-row element count
kubectl -n $NS exec sts/openddil-postgres-hq -- \
  psql -U openddil -d openddil -c \
  "SELECT asset_id, platform_variant, profile_name,
          jsonb_array_length(elements) AS n_elems,
          operational->>'power_state' AS power,
          operational->>'health_state' AS health,
          operational->>'actively_transmitting' AS tx,
          operational->>'actively_receiving' AS rx,
          operational->>'degraded' AS degraded
   FROM asset_element_telemetry;"
```

In the MaintainerApp, select an MRAD asset (e.g.
`demo:***_MRAD2_radar`). The `SensorArrayView` should render
the MRAD layout. Element colors should reflect what the sim generated
for that asset. If the customer sim reports the asset as
maintenance / faulted / tx-off / rx-off, the per-element values
shift to match — the 3D view stays synchronized with the asset card's
operational state.

## Operational-state synchronization invariant

```
asset has any of POWER_STATE_OFF/SHUTTING_DOWN/MAINTENANCE  →
asset has any of HEALTH_STATE_DEGRADED/FAULT/FAILED         →   degraded=true
asset.tx=false AND asset.rx=false (state mismatch)          →
                                                                ↓
                                            synthesis lifts elements
                                            into DEGRADED / CRITICAL band

face element.tx_active  =  asset.actively_transmitting
face element.rx_active  =  asset.actively_receiving
internal element.tx_active  =  true (always — support electronics)
internal element.rx_active  =  true (always — support electronics)
```

## Adding LTAMDS (the canonical "add another profile" recipe)

1. Tune the existing frontend `LTAMDS_CONFIG` in
   `SensorArrayView.tsx` (it already exists for the dev `?force=radar`
   override — promote it to a real platform_variant dispatch).
2. Add the LTAMDS variants to `DiagnosticCanvas.tsx`'s dispatch (a
   new set similar to `MRAD_VARIANTS`).
3. Append a profile to `logisticsSim.config.asset_profiles[]` in
   `values.yaml` (or override via `--set`):
   ```yaml
   - name: ltamds
     matches_platform_variants: [LTAMDS_Sensor, LTAMDS_Radar]
     layers: [...]   # mirror LTAMDS_CONFIG.layers
     faces: [...]    # mirror LTAMDS_CONFIG.faces (LTAMDS has 3)
     synthesis: {...}
   ```
4. `helm upgrade` — the sim picks up the new profile on pod restart,
   the projector handles the new variants uniformly (one topic, one
   table, one hook), the frontend dispatches by variant.

No new repos, no new tables, no new projector handlers — just config
+ the variant dispatch in the frontend.

## Disabling the sim

```bash
helm upgrade openddil openddil-demo -n $NS \
    --set logisticsSim.enabled=false ...
```

`SensorArrayView` falls back to seeded RNG synthesis — demo still
works, just won't reflect the customer-sim operational_state or tx/rx
state.
