// Shared asset-picker helpers (AssetSwitcher and anything else that lists
// fleet assets with their liveness).
import type { FleetAsset } from '../hooks';
import { assetLabel } from './assetLabel';
import { tierLabel, type AssetTier } from './assetTier';

/** True for the silent tiers (STALE / COMM_LOST / LOST). ACTIVE, DEGRADED and
 *  an unknown tier are "live" and render bare. */
export function isNonLiveTier(tier: AssetTier | undefined): tier is AssetTier {
  return !!tier && tier !== 'ACTIVE' && tier !== 'DEGRADED';
}

/** The suffix word for a non-live tier, e.g. "LOST"; '' when live. */
export function tierSuffix(tier: AssetTier | undefined): string {
  return isNonLiveTier(tier) ? tierLabel(tier).toUpperCase() : '';
}

// asset_id-first label (assetLabel) so assets with a shared callsign stay
// distinguishable; platform_variant appended for context. Non-live tiers are
// suffixed so the operator sees which assets they are navigating into are
// silent. ACTIVE / DEGRADED render bare.
export function pickerLabel(a: FleetAsset, tier: AssetTier | undefined): string {
  const base = a.platform_variant
    ? `${assetLabel(a)} (${a.platform_variant})`
    : assetLabel(a);
  const suffix = tierSuffix(tier);
  return suffix ? `${base} — ${suffix}` : base;
}
