// =============================================================================
// EngagementWatchlist — per-asset Sub-phase F engagement-worthiness panel
// =============================================================================
// Cross-cut of asset_logistics_status that the existing TopFactors panel
// (region rollup) and AssetDeepDive (per-asset detail) don't directly cover:
// "which assets in this region are NOT engagement-worthy right now, and
// why?"
//
// Reads useAllLogisticsStatus and filters to:
//   * assets in the active region (region_id == regionId),
//   * with at least one `inventory.*` ConstrainingFactor on
//     asset_logistics_status.constraining_factors[].factor_id (the
//     ORIGIN_DERIVED inventory factors emitted by logistics-fusion's
//     _eval_inventory — recipe v3 Sub-phase F).
//
// Sorted by overall_severity (CRITICAL > DEGRADED > others) so a glance
// shows the worst-state launchers first.
// =============================================================================
import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  useAllLogisticsStatus,
  type ConstrainingFactor,
  type LogisticsStatus,
} from '../../hooks';
import { severityHeatClass, shortSeverity } from '../../lib/fleetAggregates';

/** Severity sort key — CRITICAL first, then DEGRADED, others last. */
const SEVERITY_RANK: Record<string, number> = {
  LOGISTICS_SEVERITY_CRITICAL: 0,
  LOGISTICS_SEVERITY_NON_OPERATIONAL: 0,
  LOGISTICS_SEVERITY_DEGRADED: 1,
  LOGISTICS_SEVERITY_OK: 2,
  LOGISTICS_SEVERITY_UNSPECIFIED: 3,
};

function isInventoryFactor(f: ConstrainingFactor): boolean {
  return f.factor_id.startsWith('inventory.');
}

interface WatchRow {
  asset_id: string;
  severity: string;
  factors: ConstrainingFactor[];
}

function buildWatchlist(
  logistics: LogisticsStatus[],
  regionId: string | null,
): WatchRow[] {
  return logistics
    .filter((l) => !regionId || l.region_id === regionId)
    .map((l) => ({
      asset_id: l.asset_id,
      severity: l.overall_severity,
      factors: l.constraining_factors.filter(isInventoryFactor),
    }))
    .filter((r) => r.factors.length > 0)
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity] ?? 99;
      const sb = SEVERITY_RANK[b.severity] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.asset_id.localeCompare(b.asset_id);
    });
}

export default function EngagementWatchlist({
  regionId,
}: {
  regionId: string | null;
}) {
  const logistics = useAllLogisticsStatus();
  const rows = useMemo(
    () => buildWatchlist(logistics.data, regionId),
    [logistics.data, regionId],
  );

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
        Engagement-Worthiness Watchlist
        {regionId && (
          <span className="ml-auto text-[9px] text-slate-500 normal-case tracking-normal">
            {regionId}
          </span>
        )}
      </h2>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-500">
          No engagement-worthiness factors in this region — all assets within ammo thresholds.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.asset_id} className="border border-slate-800 rounded-sm p-1.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-bold text-slate-200 truncate" title={r.asset_id}>
                  {r.asset_id}
                </span>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-sm border ${severityHeatClass(r.severity)}`}>
                  {shortSeverity(r.severity)}
                </span>
              </div>
              {r.factors.map((f) => (
                <div key={f.factor_id} className="text-[10px] text-slate-400 leading-tight pl-1 mt-0.5">
                  {f.description ?? f.factor_id}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
