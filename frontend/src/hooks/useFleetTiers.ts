// =============================================================================
// useFleetTiers — per-asset AssetTier with recovery hysteresis
// =============================================================================
// Combines:
//   * the stateless classifier in lib/assetTier (LOST / COMM_LOST /
//     STALE / DEGRADED / ACTIVE based on time + health + link state)
//   * recovery hysteresis (the "don't snap back to ACTIVE on a single
//     late sample" rule the operator asked for)
//   * a 1Hz heartbeat so silent assets transition through tiers even
//     when no ElectricSQL updates arrive
//
// The classifier-derived tier can DOWNGRADE freely (a fresh STALE
// reading wins over the cached ACTIVE). Going BACK UP from a silent
// tier (STALE / COMM_LOST / LOST) to a live tier (ACTIVE / DEGRADED)
// requires `recovery_samples_n` distinct sample timestamps observed
// within `recovery_window_s` seconds. Below that bar, the asset stays
// in the previous silent tier so a single momentary reconnect doesn't
// yank it back to ACTIVE.
//
// Within the live tiers (ACTIVE <-> DEGRADED) transitions are free --
// they're about health state, not comms recovery.
//
// State is per-asset, held in a useRef Map. Lost across page reloads
// (acceptable; the classifier eventually re-classifies from row state
// on its own, just without the recovery gating for the first cycle).

import { useEffect, useMemo, useRef, useState } from 'react';
import { deployment } from '../deployment';
import {
  applyRecoveryHysteresis,
  classifyAssetTier,
  type AssetTier,
} from '../lib/assetTier';
import type { FleetAsset } from './useFleetAssets';

interface TrackerEntry {
  /** Sample timestamps (ms) observed within the recovery window. */
  samples: number[];
  /** Tier we returned for this asset last cycle. */
  lastTier: AssetTier | null;
}

/** Per-asset tier map keyed by asset_id. Always present for every
 *  asset in the input fleet array. */
export type FleetTierMap = ReadonlyMap<string, AssetTier>;

/** Hook input. The asset's edge_link_severed is supplied as either a
 *  per-edge map OR a single global boolean (the singleton
 *  edge_buffer_status pattern the current schema uses). Pass a Map
 *  when production goes per-edge. */
export type EdgeLinkSeveredSource =
  | boolean
  | ReadonlyMap<string, boolean>;

function lookupSevered(
  edgeId: string | null,
  src: EdgeLinkSeveredSource | undefined,
): boolean {
  if (src === undefined) return false;
  if (typeof src === 'boolean') return src;
  if (!edgeId) return false;
  return src.get(edgeId) ?? false;
}

/** Returns a Map<asset_id, AssetTier> with one entry per asset in
 *  `fleet`. Re-renders the consumer at 1Hz so silent assets transition
 *  through tiers without needing an inbound ElectricSQL update.
 *
 *  Thresholds come from deployment().liveness, set via deployment.json
 *  (per-deployment override) with DEFAULT_LIVENESS as fallback. */
export function useFleetTiers(
  fleet: FleetAsset[],
  edgeLinkSevered?: EdgeLinkSeveredSource,
): FleetTierMap {
  const thresholds = deployment().liveness;
  const trackerRef = useRef<Map<string, TrackerEntry>>(new Map());

  // 1Hz tick so the classifier re-evaluates silent assets. Without
  // this, ElectricSQL only re-fires on row writes; an asset that goes
  // silent generates no writes, no re-renders, and the cached tier
  // stays stuck at ACTIVE.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return useMemo<FleetTierMap>(() => {
    const out = new Map<string, AssetTier>();
    const nowMs = Date.now();
    const tracker = trackerRef.current;
    const windowStart = nowMs - thresholds.recovery_window_s * 1000;

    for (const a of fleet) {
      let state = tracker.get(a.asset_id);
      if (!state) {
        state = { samples: [], lastTier: null };
        tracker.set(a.asset_id, state);
      }

      // Record this sample timestamp if it's newer than the latest
      // we've already tracked. A row that hasn't changed since the
      // last render contributes nothing -- recovery needs DISTINCT
      // samples, not repeat-readings of the same sample.
      const sampleMs = a.last_sample_at ? Date.parse(a.last_sample_at) : NaN;
      if (Number.isFinite(sampleMs)) {
        const latest = state.samples.length > 0
          ? state.samples[state.samples.length - 1]
          : -Infinity;
        if (sampleMs > latest) {
          state.samples.push(sampleMs);
        }
      }

      // Trim entries older than the recovery window AND cap at
      // recovery_samples_n so the array doesn't grow unbounded for a
      // chatty asset.
      while (state.samples.length > 0 && state.samples[0] < windowStart) {
        state.samples.shift();
      }
      if (state.samples.length > thresholds.recovery_samples_n) {
        state.samples.splice(0, state.samples.length - thresholds.recovery_samples_n);
      }

      const candidate = classifyAssetTier({
        lastSampleAt: a.last_sample_at,
        healthState: a.operational_state.health_state,
        edgeLinkSevered: lookupSevered(a.edge_id, edgeLinkSevered),
        nowMs,
      }, thresholds);

      // Hysteresis core: pure function over (lastTier, candidate,
      // samplesInWindow, recoverySamplesN). See lib/assetTier's
      // applyRecoveryHysteresis for the full rule set.
      const tier = applyRecoveryHysteresis(
        state.lastTier,
        candidate,
        state.samples.length,
        thresholds.recovery_samples_n,
      );

      state.lastTier = tier;
      out.set(a.asset_id, tier);
    }

    // Drop tracker entries for assets that have left the fleet. This
    // is the only place per-asset state gets reclaimed -- without it
    // the tracker grows unbounded across many sim sessions.
    const fleetIds = new Set(fleet.map((a) => a.asset_id));
    for (const id of Array.from(tracker.keys())) {
      if (!fleetIds.has(id)) tracker.delete(id);
    }

    return out;
  }, [fleet, edgeLinkSevered, tick, thresholds]);
}
