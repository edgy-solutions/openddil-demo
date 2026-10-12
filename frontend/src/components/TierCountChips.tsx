// Fleet liveness summary: "AC 5 · DG 1 · ..." per tier.
import type { FleetAsset, FleetTierMap } from '../hooks';
import { TIER_ORDER, tierLabel, tierShortCode, type AssetTier } from '../lib/assetTier';

// Live tiers (ACTIVE / DEGRADED) use the live-fleet palette; silent tiers use
// the matching slate/amber/rose tone the operator sees on the 3D scene's ring
// outlines.
const TIER_CHIP_CLASS: Record<AssetTier, string> = {
  ACTIVE:    'text-emerald-300',
  DEGRADED:  'text-amber-300',
  STALE:     'text-slate-400',
  COMM_LOST: 'text-amber-500',
  LOST:      'text-rose-400',
};

export default function TierCountChips({ fleet, tiers }: {
  fleet: FleetAsset[];
  tiers: FleetTierMap | undefined;
}) {
  // No tier data yet (cold start) -> render nothing rather than five zeros.
  if (!tiers || fleet.length === 0) return null;

  const counts: Record<AssetTier, number> = {
    ACTIVE: 0, DEGRADED: 0, STALE: 0, COMM_LOST: 0, LOST: 0,
  };
  for (const a of fleet) counts[tiers.get(a.asset_id) ?? 'ACTIVE']++;

  // Best-to-worst; ACTIVE always shown, others only when non-zero.
  const visible = TIER_ORDER.slice().reverse().filter(
    (t) => t === 'ACTIVE' || counts[t] > 0,
  );

  return (
    <span className="flex items-center gap-2 font-mono text-[10px] tracking-wider">
      {visible.map((t, i) => (
        <span key={t} className={TIER_CHIP_CLASS[t]} title={tierLabel(t)}>
          {i > 0 && <span className="text-slate-600 mr-2">·</span>}
          {tierShortCode(t)} {counts[t]}
        </span>
      ))}
    </span>
  );
}
