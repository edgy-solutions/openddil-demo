// =============================================================================
// CmStateCard — per-asset Configuration Management state
// =============================================================================
// Renders an asset_cm_state row (useCmState): overall_status badge,
// baseline, lifecycle, discrepancy counts, and an expandable discrepancy
// list. Reused by the maintainer view; the regional/HQ views aggregate
// CM state rather than showing this card.
import { useState } from 'react';
import { ShieldAlert, ChevronRight } from 'lucide-react';
import type { CmState } from '../hooks';

export function cmStatusBadge(status: string | undefined): { label: string; cls: string } {
  switch (status) {
    case 'CONFIG_STATUS_IN_COMPLIANCE':
      return { label: 'IN COMPLIANCE', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
    case 'CONFIG_STATUS_MINOR_DISCREPANCY':
      return { label: 'MINOR DISCREPANCY', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    case 'CONFIG_STATUS_MAJOR_DISCREPANCY':
      return { label: 'MAJOR DISCREPANCY', cls: 'bg-orange-500/20 text-orange-400 border-orange-500/50' };
    case 'CONFIG_STATUS_NOT_MISSION_CAPABLE':
      return { label: 'NOT MISSION CAPABLE', cls: 'bg-rose-500/20 text-rose-400 border-rose-500/50' };
    default:
      return { label: 'NO CM STATE', cls: 'bg-slate-700/40 text-slate-400 border-slate-600' };
  }
}

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replace(/^LIFECYCLE_/, '');
}

export default function CmStateCard({ cm }: { cm: CmState | null }) {
  const [expanded, setExpanded] = useState(false);
  const badge = cmStatusBadge(cm?.overall_status);
  const discrepancies = cm?.discrepancies ?? [];
  const manual = cm?.manual_discrepancies ?? [];
  const totalDisc = discrepancies.length + manual.length;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <ShieldAlert className="w-4 h-4 mr-2" /> Configuration Management
      </h2>

      {!cm && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No CM state for this asset yet.
        </div>
      )}

      {cm && (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border ${badge.cls}`}>
              {badge.label}
            </span>
            <span className="text-[10px] text-slate-500 uppercase">{lifecycleLabel(cm.lifecycle)}</span>
          </div>
          <div className="text-xs text-slate-400 space-y-1 mb-2">
            <div className="flex justify-between">
              <span className="text-slate-500">Baseline</span>
              <span className="text-slate-300">{cm.baseline_id ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Discrepancies</span>
              <span className="text-slate-300">
                {discrepancies.length}
                {manual.length > 0 && <span className="text-amber-400"> +{manual.length} manual</span>}
              </span>
            </div>
          </div>

          {totalDisc > 0 && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center"
            >
              <ChevronRight className={`w-3 h-3 mr-1 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              {expanded ? 'Hide' : 'View'} discrepancies
            </button>
          )}

          {expanded && (
            <div className="mt-2 space-y-1 text-[11px] max-h-48 overflow-y-auto pr-1">
              {[...discrepancies, ...manual].map((d: any, i: number) => (
                <div key={d.discrepancy_id ?? i} className="border-l-2 border-slate-600 pl-2 py-0.5">
                  <div className="text-slate-300">{d.description ?? d.discrepancy_id ?? 'discrepancy'}</div>
                  {d.recommended_action && (
                    <div className="text-slate-500">{d.recommended_action}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
