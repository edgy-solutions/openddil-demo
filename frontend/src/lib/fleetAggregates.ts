// =============================================================================
// fleetAggregates — pure fleet-level rollups (post-§C.1 prune)
// =============================================================================
// Shared by the regional and HQ views. Pure functions over the shape-hook
// row arrays — no hooks, no I/O — so they're trivially testable and reused.
//
// Phase 6c.1 pruned the client-side group-by functions that have aggregator-
// sourced replacements:
//   topConstrainingFactors  -> useRegionTopFactors (per-region, merged at
//                              HQ inline)
//   cmComplianceSummary     -> useRegionFleetSummary severity buckets
//                              (WORST-of(logistics, cm) collapsed)
//   logisticsSeveritySummary -> useRegionFleetSummary severity buckets
//   wearTrendRollup         -> useRegionWearTrends (per-region, merged at
//                              HQ inline)
//
// What's left here is per-asset display helpers (severityRank,
// severityHeatClass, shortSeverity) plus the two per-platform-family
// slicers (mwoComplianceByFamily, baselineDistribution) and the
// per-asset picker join helper (aorAssetList). None of these has an
// aggregator-sourced replacement — the rolled-up topics are
// region-level, not per-asset or per-platform-family.
//
// CM-status label formatting is NOT here: it lives in the single
// cmStatusBadge() helper (components/CmStateCard) so the label +
// color stay consistent everywhere CM status renders (maintainer
// card, regional + HQ recommendations). A previous shortCmStatus()
// helper that raw-formatted the enum (producing the overclaiming
// "NOT MISSION CAPABLE") was removed — it was unused and a divergence
// trap. Use cmStatusBadge() for any CM-status rendering.
import type { CmState, LogisticsStatus, FleetAsset } from '../hooks';

// --- severity / status ordering ---------------------------------------------

// Worst-first rank for logistics severity (drives sort + heatmap colour).
const SEVERITY_RANK: Record<string, number> = {
  LOGISTICS_SEVERITY_NON_OPERATIONAL: 4,
  LOGISTICS_SEVERITY_CRITICAL: 3,
  LOGISTICS_SEVERITY_DEGRADED: 2,
  LOGISTICS_SEVERITY_OK: 1,
  LOGISTICS_SEVERITY_UNSPECIFIED: 0,
};
export function severityRank(sev: string | undefined): number {
  return sev ? (SEVERITY_RANK[sev] ?? 0) : 0;
}

// Tailwind classes for a severity heatmap cell.
export function severityHeatClass(sev: string | undefined): string {
  switch (sev) {
    case 'LOGISTICS_SEVERITY_OK': return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'LOGISTICS_SEVERITY_DEGRADED': return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'LOGISTICS_SEVERITY_CRITICAL': return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    case 'LOGISTICS_SEVERITY_NON_OPERATIONAL': return 'bg-rose-700/30 text-rose-200 border-rose-700/60';
    default: return 'bg-slate-700/30 text-slate-400 border-slate-600';
  }
}

export function shortSeverity(sev: string | undefined): string {
  return (sev ?? 'UNSPECIFIED').replace(/^LOGISTICS_SEVERITY_/, '');
}

// --- AOR asset list (fleet joined with logistics severity) ------------------
// Per-asset picker join helper. The aggregator emits region-level rollups,
// not per-asset rows — the picker needs the per-asset join so each row
// shows its own severity color. This is NOT replaceable by aggregator
// output (region rollup loses the per-asset granularity by definition).

export interface AorRow {
  asset_id: string;
  callsign: string | null;
  platform_variant: string | null;
  severity: string;
}

/** Join the fleet roster with logistics severity; worst severity first. */
export function aorAssetList(
  fleet: FleetAsset[],
  logistics: LogisticsStatus[],
): AorRow[] {
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));
  return fleet
    .map((a) => ({
      asset_id: a.asset_id,
      callsign: a.callsign,
      platform_variant: a.platform_variant,
      severity: sevByAsset.get(a.asset_id) ?? 'LOGISTICS_SEVERITY_UNSPECIFIED',
    }))
    .sort((x, y) => severityRank(y.severity) - severityRank(x.severity));
}

// --- per-platform-family slicers (HQ-only, no aggregator replacement) -------
// The rolled-up topics slice by region, not by platform_variant. These
// two functions stay because they answer a different question (how does
// MWO compliance / baseline distribution vary across platform families)
// that the regional rollups don't cover.

/** Coarse platform family from a platform_variant ("M1A2-SEPv3" -> "M1A2"). */
export function platformFamily(variant: string | null | undefined): string {
  if (!variant) return 'UNKNOWN';
  return variant.split('-')[0] || variant;
}

export interface MwoComplianceRow {
  family: string;
  total: number;
  compliant: number;   // assets with no overdue mods
  rate: number;        // 0..1
}

/**
 * MWO/TCTO compliance by platform family. cm rows carry mod_status but not
 * platform_variant — joined with the fleet roster (telemetry_latest_state)
 * on asset_id to recover the family. An asset is "compliant" if none of
 * its mods are in MOD_STATE_OVERDUE.
 */
export function mwoComplianceByFamily(
  cm: CmState[],
  fleet: FleetAsset[],
): MwoComplianceRow[] {
  const variantByAsset = new Map(fleet.map((a) => [a.asset_id, a.platform_variant]));
  const byFamily = new Map<string, { total: number; compliant: number }>();
  for (const row of cm) {
    const family = platformFamily(variantByAsset.get(row.asset_id));
    const overdue = (row.mod_status ?? []).some(
      (m: any) => m?.state === 'MOD_STATE_OVERDUE' || m?.state === 3,
    );
    const entry = byFamily.get(family) ?? { total: 0, compliant: 0 };
    entry.total += 1;
    if (!overdue) entry.compliant += 1;
    byFamily.set(family, entry);
  }
  return [...byFamily.entries()]
    .map(([family, e]) => ({
      family,
      total: e.total,
      compliant: e.compliant,
      rate: e.total > 0 ? e.compliant / e.total : 0,
    }))
    .sort((a, b) => a.rate - b.rate);  // worst compliance first
}

export interface BaselineBucket {
  baseline_id: string;
  count: number;
}

/** Count assets per baseline_id. */
export function baselineDistribution(cm: CmState[]): BaselineBucket[] {
  const counts = new Map<string, number>();
  for (const row of cm) {
    const id = row.baseline_id ?? '(none)';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([baseline_id, count]) => ({ baseline_id, count }))
    .sort((a, b) => b.count - a.count);
}
