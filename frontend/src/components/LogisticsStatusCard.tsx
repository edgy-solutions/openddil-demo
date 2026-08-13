// =============================================================================
// LogisticsStatusCard — per-asset logistics severity
// =============================================================================
// Renders an asset_logistics_status row (useLogisticsStatus):
// overall_severity badge, the constraining factors pulling severity above
// OK (with current value vs threshold where quantitative), and the
// projected mission-capable-remaining estimate. Reused by the maintainer
// view.
import { Fuel } from 'lucide-react';
import type { LogisticsStatus, ConstrainingFactor, OperationalState } from '../hooks';
import { opStateBackfill } from '../lib/opStateBackfill';
import { basisKind, describeBasis } from '../lib/valueBasis';
import { SyncingNotice } from './SyncingNotice';

/** Duration proto JSON ("21600s") -> seconds. Returns null when absent. */
function durationSeconds(d?: string): number | null {
  if (!d) return null;
  const n = parseFloat(d.endsWith('s') ? d.slice(0, -1) : d);
  return Number.isFinite(n) ? n : null;
}

/** The factor that produced the composed horizon.
 *
 *  ADR-0035 IH-6. `projected_mission_capable_remaining` is the SOONEST
 *  factor's `projected_time_to_worse` (fusion compose_status), so the
 *  horizon's basis is that factor's provenance. Recomputing the same
 *  minimum here keeps the marker keyed off the producer's stamp rather
 *  than off this field's name — when another evaluator starts projecting,
 *  or a registered analytics unit replaces the rule, the marker follows
 *  the data with no edit here.
 *
 *  Returns null when nothing projected — a horizon with no projecting
 *  factor is not something to badge, it is something to leave alone. */
function horizonSource(factors: ConstrainingFactor[]): ConstrainingFactor | null {
  let best: ConstrainingFactor | null = null;
  let bestS: number | null = null;
  for (const f of factors) {
    const s = durationSeconds(f.projected_time_to_worse);
    if (s == null) continue;
    if (bestS == null || s < bestS) { bestS = s; best = f; }
  }
  return best;
}

/** Modelled-not-measured marker. Mirrors the SYNTHESIZED badge's amber
 *  treatment (Inventory / TelemetryCharts) so the operator meets one
 *  visual vocabulary for "this is not a measurement" across the COP.
 *  Renders nothing when the value carries no stamp — an absent badge means
 *  "no claim", never "measured". */
function DerivedBadge({ title }: { title: string }) {
  return (
    <span
      className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase rounded-sm cursor-help"
      title={title}
    >
      DERIVED
    </span>
  );
}

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

// opStateBackfill lives in lib/ — see opStateBackfill.ts and its
// __tests__/. The precedence policy (HEALTH_FAILED > HEALTH_FAULT >
// POWER_OFF > POWER_SHUTTING_DOWN > HEALTH_DEGRADED > POWER_MAINTENANCE)
// is pinned by unit tests there.

export default function LogisticsStatusCard({
  logistics, opState = null, isLoading = false,
}: {
  logistics: LogisticsStatus | null;
  /** Phase 5 backfill: when fusion hasn't emitted a row yet but the
   *  per-asset operational_state shows the asset is non-nominal, surface
   *  an INFERRED severity row so the operator sees the signal that's
   *  already in the data. Labelled "(inferred)" so the rendered row is
   *  honest about its provenance — not a fusion verdict. */
  opState?: OperationalState | null;
  isLoading?: boolean;
}) {
  const badge = severityBadge(logistics?.overall_severity);
  const factors = logistics?.constraining_factors ?? [];

  // Only show the inferred row when fusion has nothing — once fusion
  // emits a factor (even an `operational.*` one), it IS the source of
  // truth and the inferred row would be redundant + confusing.
  const showBackfill =
    !logistics ||
    logistics.overall_severity === 'LOGISTICS_SEVERITY_UNSPECIFIED' ||
    !logistics.overall_severity;
  const backfill = showBackfill ? opStateBackfill(opState) : null;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Fuel className="w-4 h-4 mr-2" /> Logistics Status
      </h2>

      {/* syncing -> genuinely empty -> data; the syncing state must never
          fall through to the empty copy (cold-start race). */}
      {isLoading && <SyncingNotice label="Syncing logistics state…" />}

      {!isLoading && !logistics && !backfill && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No logistics state for this asset yet.
        </div>
      )}

      {!isLoading && !logistics && backfill && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border ${backfill.cls}`}>
              {backfill.label}
            </span>
            <span className="text-[9px] text-slate-500 uppercase tracking-wider">no fusion row</span>
          </div>
          <div className="text-[11px] text-slate-400">{backfill.rationale}</div>
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
                {(() => {
                  // ADR-0035 IH-6. The value is unchanged; only its basis
                  // becomes visible. Keyed off the producing factor's
                  // `origin` stamp (IH-5), not off this field's identity.
                  const src = horizonSource(factors);
                  if (!src || basisKind(src) !== 'DERIVED') return null;
                  const title = describeBasis(src);
                  return title ? <DerivedBadge title={title} /> : null;
                })()}
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
          ) : backfill ? (
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                Inferred from operational state (no fusion factor yet)
              </div>
              <div className="border-l-2 border-amber-500/50 pl-2 py-0.5 text-[11px]">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300">{backfill.label.toLowerCase().replace(' (inferred)', '')}</span>
                  <span className={`text-[9px] font-bold px-1 py-px rounded-sm border ${backfill.cls}`}>
                    {backfill.label}
                  </span>
                </div>
                <div className="text-slate-500">{backfill.rationale}</div>
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-slate-500">No constraining factors.</div>
          )}
        </>
      )}
    </div>
  );
}
