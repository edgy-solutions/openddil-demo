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
import { useMunitionLaunches } from './useEffectorLaunches';
import { launchesByMunition, launchFor } from '../lib/munitionAsset';

export interface ClassifiedFleetAsset extends FleetAsset {
  asset_class: AssetClass;
  /** Set only for MUNITION-class assets: the launcher declared by the
   *  munition's effector_launch row. Null when no launch row names this
   *  munition -- never inferred from the asset_id. */
  parent_launcher_id: string | null;
  /** Set only for MUNITION-class assets: the event_urn of the munition's
   *  launch row. Paired with parent_launcher_id it forms the firing
   *  identity for dedup. Null when there is no launch row. */
  firing_event_urn: string | null;
}

export interface ClassifiedFleetResult {
  data: ClassifiedFleetAsset[];
  isLoading: boolean;
  isError: boolean;
}

export function useClassifiedFleet(): ClassifiedFleetResult {
  const fleet = useFleetAssets();
  const capabilities = useAllCapabilityState();
  const launches = useMunitionLaunches();

  const data = useMemo<ClassifiedFleetAsset[]>(() => {
    // Set membership check is O(1); building the Set once per data change
    // is cheaper than an inner-loop find over capabilities.data for every
    // fleet asset (~O(f * c) -> O(f + c)).
    const launcherIds = new Set(capabilities.data.map((c) => c.asset_id));
    const launchByMunition = launchesByMunition(launches.data);
    return fleet.data.map((a) => {
      const asset_class = classifyAsset(a.platform_variant, launcherIds.has(a.asset_id));
      // Launcher + launch event come from the declared launch row, and
      // only for MUNITION-class rows. For every other class they stay null.
      if (asset_class === 'MUNITION') {
        return {
          ...a,
          asset_class,
          ...launchFor(a.asset_id, launchByMunition),
        };
      }
      return {
        ...a,
        asset_class,
        parent_launcher_id: null,
        firing_event_urn: null,
      };
    });
  }, [fleet.data, capabilities.data, launches.data]);

  return {
    data,
    // Loading state: either source still loading -> we're loading. Once
    // BOTH have first-synced we're stable, even if one is empty (e.g.
    // pre-scenario the capability table has zero rows -- valid, not
    // still-loading).
    isLoading: fleet.isLoading || capabilities.isLoading || launches.isLoading,
    isError: fleet.isError || capabilities.isError || launches.isError,
  };
}
