// =============================================================================
// LogisticsStatusCard — per-asset logistics severity
// =============================================================================
// Renders an asset_logistics_status row (useLogisticsStatus):
// overall_severity badge, the constraining factors pulling severity above
// OK (with current value vs threshold where quantitative), and the
// projected mission-capable-remaining estimate. Reused by the maintainer
// view.
import { Fuel } from 'lucide-react';
import type { LogisticsStatus, ConstrainingFactor } from '../hooks';
import { SyncingNotice } from './SyncingNotice';

export function severityBadge(sev: string | undefined): { label: string; cls: string } {
  switch (sev) {
    case 'LOGISTICS_SEVERITY_OK':
      return { label: 'OK', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
    case 'LOGISTICS_SEVERITY_DEGRADED':
      return { label: 'DEGRADED', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    case 'LOGISTICS_SEVERITY_CRITICAL':
      return { label: 'CRITICAL', cls: 'bg-rose-500/20 text-rose-400 border-rose-500/50' };
    case 'LOGISTICS_SEVERITY_NON_OPERATIONAL':
      return { label: 'NON-OPERATIONAL', cls: 'bg-rose-700/30 text-rose-300 border-rose-700/60' };
    default:
      return { label: 'NO LOGISTICS STATE', cls: 'bg-slate-700/40 text-slate-400 border-slate-600' };
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds <= 0) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function quantityStr(q?: { value: number; unit: string }): string | null {
  if (!q || typeof q.value !== 'number') return null;
  return `${q.value.toFixed(1)}${q.unit ? ' ' + q.unit : ''}`;
}

function FactorRow({ factor }: { factor: ConstrainingFactor }) {
  const badge = severityBadge(factor.severity);
  const current = quantityStr(factor.current_value);
  const threshold = quantityStr(factor.threshold);
  return (
    <div className="border-l-2 border-slate-600 pl-2 py-0.5 text-[11px]">
      <div className="flex justify-between items-center">
        <span className="text-slate-300">{factor.factor_id}</span>
        <span className={`text-[9px] font-bold px-1 py-px rounded-sm border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {factor.description && <div className="text-slate-500">{factor.description}</div>}
      {(current || threshold) && (
        <div className="text-slate-500">
          {current && <span>now {current}</span>}
          {current && threshold && <span> · </span>}
          {threshold && <span>threshold {threshold}</span>}
        </div>
      )}
    </div>
  );
}

export default function LogisticsStatusCard({ logistics, isLoading = false }: { logistics: LogisticsStatus | null; isLoading?: boolean }) {
  const badge = severityBadge(logistics?.overall_severity);
  const factors = logistics?.constraining_factors ?? [];

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Fuel className="w-4 h-4 mr-2" /> Logistics Status
      </h2>

      {/* syncing -> genuinely empty -> data; the syncing state must never
          fall through to the empty copy (cold-start race). */}
      {isLoading && <SyncingNotice label="Syncing logistics state…" />}

      {!isLoading && !logistics && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No logistics state for this asset yet.
        </div>
      )}

      {!isLoading && logistics && (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border ${badge.cls}`}>
              {badge.label}
            </span>
            {logistics.is_transition && (
              <span className="text-[9px] text-amber-400 uppercase tracking-wider">transition</span>
            )}
          </div>
          <div className="text-xs text-slate-400 space-y-1 mb-2">
            <div className="flex justify-between">
              <span className="text-slate-500">Projected mission-capable</span>
              <span className="text-slate-300">
                {formatDuration(logistics.projected_mission_capable_remaining_seconds)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Status revision</span>
              <span className="text-slate-300">{logistics.status_revision}</span>
            </div>
          </div>

          {factors.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                Constraining factors ({factors.length})
              </div>
              {factors.map((f, i) => <FactorRow key={f.factor_id ?? i} factor={f} />)}
            </div>
          ) : (
            <div className="text-[11px] text-slate-500">No constraining factors.</div>
          )}
        </>
      )}
    </div>
  );
}
