// =============================================================================
// useClassifiedFleet -- fleet assets with an asset_class discriminator
// =============================================================================
// Combines useFleetAssets (telemetry_latest_state) with useAllCapabilityState
// (asset_capability_state) to derive asset_class client-side without needing
// a Postgres view or a schema column. See src/lib/assetClass.ts for the
// classifier rules.
//
// Cost: O(n_capabilities) Set construction per re-render; ~10s-of-launchers
// on any real deployment, no observable overhead.
//
// Callers: HQ FORCE POSTURE split, maintainer picker MUNITION filter,
// per-FOB composition roll-up (all 2026-07-13+).
import { useMemo } from 'react';

import { useFleetAssets, type FleetAsset } from './useFleetAssets';
import { useAllCapabilityState } from './useCapabilityState';
import { classifyAsset, type AssetClass } from '../lib/assetClass';
import {
  extractParentLauncherFromAssetId,
  extractFiringSequence,
} from '../lib/munitionAsset';

export interface ClassifiedFleetAsset extends FleetAsset {
  asset_class: AssetClass;
  /** Set only for MUNITION-class assets: the launcher this in-flight
   *  munition was fired from (derived by matching the launcher's asset_id
   *  as a substring in the munition's asset_id). Null when we can't
   *  attribute -- e.g. a munition variant whose naming doesn't embed
   *  the launcher id. */
  parent_launcher_id: string | null;
  /** Set only for MUNITION-class assets: the integer firing sequence
   *  parsed from the asset_id (`<TYPE>_<SEQ>-<PARENT>...` convention).
   *  Null when the pattern doesn't match. Paired with parent_launcher_id
   *  it forms a stable firing identity for dedup. */
  firing_sequence: number | null;
}

export interface ClassifiedFleetResult {
  data: ClassifiedFleetAsset[];
  isLoading: boolean;
  isError: boolean;
}

export function useClassifiedFleet(): ClassifiedFleetResult {
  const fleet = useFleetAssets();
  const capabilities = useAllCapabilityState();

  const data = useMemo<ClassifiedFleetAsset[]>(() => {
    // Set membership check is O(1); building the Set once per data change
    // is cheaper than an inner-loop find over capabilities.data for every
    // fleet asset (~O(f * c) -> O(f + c)).
    const launcherIds = new Set(capabilities.data.map((c) => c.asset_id));
    return fleet.data.map((a) => {
      const asset_class = classifyAsset(a.platform_variant, launcherIds.has(a.asset_id));
      // Parent-launcher + firing-sequence extraction only makes sense for
      // MUNITION-class rows (in-flight munitions embed both in the asset_id).
      // For every other class the fields stay null.
      if (asset_class === 'MUNITION') {
        return {
          ...a,
          asset_class,
          parent_launcher_id: extractParentLauncherFromAssetId(a.asset_id, launcherIds),
          firing_sequence: extractFiringSequence(a.asset_id),
        };
      }
      return {
        ...a,
        asset_class,
        parent_launcher_id: null,
        firing_sequence: null,
      };
    });
  }, [fleet.data, capabilities.data]);

  return {
    data,
    // Loading state: either source still loading -> we're loading. Once
    // BOTH have first-synced we're stable, even if one is empty (e.g.
    // pre-scenario the capability table has zero rows -- valid, not
    // still-loading).
    isLoading: fleet.isLoading || capabilities.isLoading,
    isError: fleet.isError || capabilities.isError,
  };
}
