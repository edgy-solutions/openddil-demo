// =============================================================================
// fleetAggregates — pure fleet-level rollups (Phase 4c)
// =============================================================================
// Shared by the regional and HQ views. Pure functions over the shape-hook
// row arrays — no hooks, no I/O — so they're trivially testable and reused.
import type { CmState, LogisticsStatus, FleetAsset, TelemetryWindows } from '../hooks';

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

export function shortCmStatus(status: string | undefined): string {
  return (status ?? 'UNSPECIFIED').replace(/^CONFIG_STATUS_/, '').replace(/_/g, ' ');
}

// --- AOR asset list (fleet joined with logistics severity) ------------------

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

// --- top-N constraining factors across the fleet ----------------------------

export interface FactorRollup {
  factor_id: string;
  affectedAssets: number;
  worstSeverity: string;
}

/** Group constraining_factors across all logistics rows by factor_id. */
export function topConstrainingFactors(
  logistics: LogisticsStatus[],
  limit = 10,
): FactorRollup[] {
  const byFactor = new Map<string, { assets: Set<string>; worst: string }>();
  for (const row of logistics) {
    for (const f of row.constraining_factors ?? []) {
      if (!f?.factor_id) continue;
      const entry = byFactor.get(f.factor_id) ?? { assets: new Set<string>(), worst: 'LOGISTICS_SEVERITY_UNSPECIFIED' };
      entry.assets.add(row.asset_id);
      if (severityRank(f.severity) > severityRank(entry.worst)) entry.worst = f.severity;
      byFactor.set(f.factor_id, entry);
    }
  }
  return [...byFactor.entries()]
    .map(([factor_id, e]) => ({ factor_id, affectedAssets: e.assets.size, worstSeverity: e.worst }))
    .sort((a, b) => b.affectedAssets - a.affectedAssets || severityRank(b.worstSeverity) - severityRank(a.worstSeverity))
    .slice(0, limit);
}

// --- CM compliance summary --------------------------------------------------

export interface CmComplianceBucket {
  status: string;
  count: number;
}

/** Group CM state rows by overall_status, worst-first. */
export function cmComplianceSummary(cm: CmState[]): CmComplianceBucket[] {
  const CM_RANK: Record<string, number> = {
    CONFIG_STATUS_NOT_MISSION_CAPABLE: 4,
    CONFIG_STATUS_MAJOR_DISCREPANCY: 3,
    CONFIG_STATUS_MINOR_DISCREPANCY: 2,
    CONFIG_STATUS_IN_COMPLIANCE: 1,
    CONFIG_STATUS_UNSPECIFIED: 0,
  };
  const counts = new Map<string, number>();
  for (const row of cm) {
    counts.set(row.overall_status, (counts.get(row.overall_status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => (CM_RANK[b.status] ?? 0) - (CM_RANK[a.status] ?? 0));
}

// --- HQ-level rollups -------------------------------------------------------

export interface SeverityBucket {
  severity: string;
  count: number;
}

/** Group logistics rows by overall_severity, worst-first. */
export function logisticsSeveritySummary(logistics: LogisticsStatus[]): SeverityBucket[] {
  const counts = new Map<string, number>();
  for (const row of logistics) {
    counts.set(row.overall_severity, (counts.get(row.overall_severity) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

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

export interface WearTrendRollup {
  component_key: string;
  assetCount: number;
}

/**
 * Roll up component wear trends across the fleet — which components show
 * up in asset_telemetry_windows.component_wear_trends, and how many assets
 * report each. Modest by design: windowed wear data is sparse (the DIS
 * feed produces none — see ADR-0020), so this gracefully shows little.
 */
export function wearTrendRollup(windows: TelemetryWindows[]): WearTrendRollup[] {
  const byComponent = new Map<string, Set<string>>();
  for (const row of windows) {
    for (const w of row.component_wear_trends ?? []) {
      const key = (w as any)?.component_key ?? (w as any)?.component_id;
      if (!key) continue;
      const set = byComponent.get(key) ?? new Set<string>();
      set.add(row.asset_id);
      byComponent.set(key, set);
    }
  }
  return [...byComponent.entries()]
    .map(([component_key, assets]) => ({ component_key, assetCount: assets.size }))
    .sort((a, b) => b.assetCount - a.assetCount);
}
