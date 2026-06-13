# Monday Punch List

Captured 2026-06-12 EOD, after the long deploy-fragility + correctness session.
Pick up cold from here when back on the cluster.

## Shipped this session (for context)

These are all in master on their respective repos. None of them require Monday
follow-up — listed only so you can grep `git log --oneline` and recognize the
landscape.

| # | Repo | Commit | Fix |
|---|---|---|---|
| 1 | openddil-helm | 9dde1f5 | `persistence.{redpanda,restate}UseEmptyDir` knobs (NFS-cluster escape hatch, chart 0.1.23) |
| 2 | openddil-cm-service | 27054fd | `_now_ns(ctx)` → `await ctx.run("now_ns", ...)` — kills VMException(570) |
| 3 | customer-overlay overlay (local) | 5ec4b59 | post-install hook also patches asset-registry-service with EDGE_ASSIGNMENT_CONFIG |
| 4 | openddil-helm | 9c40933 | `PYTHONPATH=/proto:/app/src` on asset-registry-service (chart 0.1.24) |
| 5 | customer-overlay overlay (local) | 9134b68 | `overlay.bundleImage` helper supports digest pinning (parity with OSS) |
| 6 | openddil-demo frontend | 0032fbf | StrikeCapabilityCard no-flash on non-strike assets |
| 7 | openddil-demo frontend | caeb075 | TypeScript cleanup — dropped unused `SyncingNotice` + `isLoading` after the no-flash patch unblocked frontend Docker build |

## Buckets to work through on Monday

### Bucket 1 — Verify Strike Capability card actually renders on strike-capable assets

The flicker patch (commit 0032fbf) eliminated the brief flash-and-disappear on
non-strike assets. **Separate suspicion from the operator**: the card may also
not be showing AT ALL on assets that have real `asset_capability_state` rows.

Evidence already in hand:
- Section 12 of every diag confirms 63 distinct assets DO have capability rows
  (`asset_capability_state: rows=63 distinct_assets=63 with_caps=63 fresh=63`)
- The hook `useCapabilityState(assetId)` filters by exact asset_id
- Component is mounted in MaintainerApp's right-rail (per file header comment)

Steps to disambiguate:
1. Pick a strike-capable asset_id:
   ```bash
   kubectl -n drone-spotter-sandbox exec deploy/openddil-postgres-hq -- \
     psql -U openddil -d openddil -c \
     "SELECT asset_id FROM asset_capability_state LIMIT 5;"
   ```
2. Navigate to that asset in the Maintainer UI
3. Open browser DevTools → React DevTools → find `StrikeCapabilityCard`
4. Capture: `assetId` prop, `data` length, first row content
5. Also confirm in the parent (MaintainerApp): is `<StrikeCapabilityCard>`
   actually conditionally rendered, or always mounted?

If `data` is populated but card still doesn't render → guard logic bug in our
patch. If `data` is empty for a strike-capable asset → `useCapabilityState`
query/subscription bug — check the SQL where clause + ElectricSQL subscription
state.

### Bucket 2 — Demo-data knobs to light up remaining cards

Three cards / panels are still empty. Two are one-line fixes; one is real data
seeding. None are bugs in the OSS chain.

#### 2a. Engagement Worthiness (regional) + tactical events
```bash
NS=drone-spotter-sandbox
kubectl -n $NS set env deploy/openddil-logistics-fusion-service AMMO_LOW_COUNT=205
kubectl -n $NS rollout status deploy/openddil-logistics-fusion-service --timeout=60s
```
Current min ammo across stores ≈ 200, threshold currently 5 → no
`inventory.ammo_*` factors fire → watchlist + tactical events stay empty.
Pushing threshold above the current minimum makes most stores match → factors
fire → faust-edge emits tactical-events → bridge forwards to HQ.

#### 2b. Configuration Posture / Enterprise CM Recommendations / Regional CM Recommendations / Maintainer CM
Need real `CmEvent` records on the `cm-events` topic to populate `installed`,
`mod_status`, `discrepancies` on `asset_cm_state` rows. The CLI is shipped at
`openddil-cm-service/cli/submit_cm_event.py` and is reachable from inside the
cm-service pod (PYTHONPATH + /proto are wired):

```bash
NS=drone-spotter-sandbox

# Pull a few asset_ids that exist
kubectl -n $NS exec deploy/openddil-postgres-hq -- \
  psql -U openddil -d openddil -c \
  "SELECT asset_id FROM asset_cm_state LIMIT 5;" -t

# For each asset, fire a mod-applied + part-replaced
ASSET="demo:***_MRAD2_radar"
kubectl -n $NS exec deploy/openddil-cm-service -c cm-service -- \
  python /app/cli/submit_cm_event.py \
    --brokers openddil-redpanda-edge-01:9092 \
    --asset-id "$ASSET" \
    --mod-applied MWO-2024-117 \
    --recorded-by maintainer-demo

kubectl -n $NS exec deploy/openddil-cm-service -c cm-service -- \
  python /app/cli/submit_cm_event.py \
    --brokers openddil-redpanda-edge-01:9092 \
    --asset-id "$ASSET" \
    --part-replaced engine:AGT-1500-RevE-SN-12345 \
    --recorded-by maintainer-demo
```
Seed 5-10 assets and every CM-related panel has real history.

### Bucket 3 — Sustainment + power_state are empty on Maintainer

Diag flags this each run:
- `sustainment is NULL for ALL 214 rows` → Maintainer Telemetry Charts empty
- `power_state: 4/214 rows` → Maintainer Ground Diagnostics mostly empty

Root cause is overlay-side: `customer-overlay/dynamic-mappings/proprietary-mapping.yaml`
does not extract sustainment + power_state fields from the customer's AMQP
payload. This is a Bloblang gap, not an OSS chain bug. Owner: customer-overlay overlay,
needs the customer's AMQP wire schema to know which paths to map.

### Bucket 4 — Movement is a sim issue, not OpenDDIL

- `ALL assets stationary, max speed=0 m/s` → derived_sustainment never
  emits → Wear Trends panels stay empty (Maintainer + Regional + HQ).

Sim's movement model. Outside OpenDDIL.

### Bucket 5 — Apply the overlay bundle digest pin

The `overlay.bundleImage` helper now supports a `digest` field (commit 9134b68
in customer-overlay overlay). Until `deploy.sh` passes it, Section 14 of diag will
keep showing `connect-proprietary` on `:latest` while every OSS pod is on the
mirror-script-captured digest. Cosmetic until it's not — the proto-loader
content drift IS a real schema-mismatch hazard for the connect protobuf
processor.

Fix: add to the helm command in `customer-overlay/k8s/deploy.sh`:
```
--set image.bundle.digest=<same sha256: as OSS values-pinned.yaml uses for bundle.image.digest>
```

After that ships, Section 14 should collapse to a single digest across all 23
bundle-consuming pods.

## Reference: standard recovery sequence

If anything goes sideways at start-of-day, the reliable rebuild is:

```bash
NS=drone-spotter-sandbox

# 1. Re-mirror (refreshes values-pinned.yaml against latest chart + image digests)
pwsh openddil-helm/scripts/mirror-to-artifactory.ps1 -RepoBase artifactory.example/openddil

# 2. OSS upgrade. emptyDir flags eliminate the redpanda-on-NFS pain.
helm upgrade openddil openddil-demo -n $NS \
    -f defaults.yaml -f values-pinned.yaml \
    --set persistence.redpandaUseEmptyDir=true \
    --set persistence.restateUseEmptyDir=true

# 3. Overlay (re-fires the asset-registry-service patch hook every revision)
bash deploy.sh

# 4. Sweep stragglers (forces fresh bundle-loader runs against pinned digest)
kubectl -n $NS rollout restart deploy -l app.kubernetes.io/name=openddil-demo
kubectl -n $NS rollout restart sts/openddil-restate-server
kubectl -n $NS rollout status sts/openddil-restate-server --timeout=300s

# 5. Flush demo data
bash k8s/flush-assets.sh

# 6. Sim start (your normal entrypoint)

# 7. Verify
bash k8s/diag.sh
```
