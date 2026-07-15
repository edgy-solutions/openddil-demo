// =============================================================================
// CmStateCard — per-asset Configuration Management state
// =============================================================================
// Renders an asset_cm_state row (useCmState): overall_status badge,
// baseline, lifecycle, discrepancy counts, installed-parts list,
// applied-mods list, and an expandable discrepancy list. Reused by the
// maintainer view; the regional/HQ views aggregate CM state rather
// than showing this card.
//
// 2026-06-29: added installed[] and mod_status[] surfacing. Before
// this, the card only rendered discrepancies, so operators using
// seed-cm-events.sh to inject part-replaced / mod-applied events
// saw the DB populate but the card stay visually empty (the seeded
// events populate installed[] / mod_status[] without producing
// discrepancies unless a baseline mismatch is also configured).
import { useState } from 'react';
import { ShieldAlert, ChevronRight, Wrench, Package } from 'lucide-react';
import type { CmState } from '../hooks';
import { SyncingNotice } from './SyncingNotice';

// Labels are domain-anchored to CM (configuration/maintenance records) --
// they must never claim FUNCTIONAL capability, because CM state and
// operational state are orthogonal axes (ADR-0026). The previous label
// "NOT MISSION CAPABLE" for CONFIG_STATUS_NOT_MISSION_CAPABLE overclaimed
// -- the phrase reads as a functional judgment when the underlying data
// is records-compliance. Stakeholders saw the red "NOT MISSION CAPABLE"
// next to a functionally green radar and concluded the display was
// broken. Fix: "CM:" prefix on every state, plain-language plus no use
// of the word "capable" (that word carries the functional claim).
//
// Amber (not red) for CONFIG_STATUS_NOT_MISSION_CAPABLE now that the
// fusion severity rollup no longer folds CM into functional severity
// (ADR-0026 compliance fix). A CM-only failure is a genuine DEGRADED
// posture (operating with a records deviation is a real deferred-
// maintenance risk) but not RED "cannot perform mission" territory.
export function cmStatusBadge(status: string | undefined): { label: string; cls: string } {
  switch (status) {
    case 'CONFIG_STATUS_IN_COMPLIANCE':
      return { label: 'CM: COMPLIANT', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
    case 'CONFIG_STATUS_MINOR_DISCREPANCY':
      return { label: 'CM: NEEDS MAINTENANCE', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    case 'CONFIG_STATUS_MAJOR_DISCREPANCY':
      return { label: 'CM: MAJOR DISCREPANCY', cls: 'bg-orange-500/20 text-orange-400 border-orange-500/50' };
    case 'CONFIG_STATUS_NOT_MISSION_CAPABLE':
      return { label: 'CM: NON-COMPLIANT', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    default:
      return { label: 'NO CM STATE', cls: 'bg-slate-700/40 text-slate-400 border-slate-600' };
  }
}

function lifecycleLabel(lifecycle: string): string {
  return lifecycle.replace(/^LIFECYCLE_/, '');
}

// The on-the-wire shape comes from the AsMaintainedConfiguration proto
// (openddil.configuration.v1.as_maintained_pb2). cm-service serializes
// installed[] as InstalledCi records and mod_status[] as ModCompliance
// records. The frontend sees the JSON of those protos -- snake_case
// field names, missing optional fields are empty-string / 0, enums
// come through as either integer (proto wire) or name string (after
// JSON serialization) depending on the producer.
//
// Initial-from-baseline path leaves ci_id empty: the slot is reserved
// but no specific CI has been recorded yet -- which is exactly the
// DISCREPANCY_MISSING_CI condition the analyzer emits. We render that
// as "(unverified)" so the operator sees the slot AND understands why
// it's also showing up in the discrepancies list.

function partLabel(p: any): string {
  if (p == null) return 'part';
  if (typeof p === 'string') return p;
  // InstalledCi proto: slot_id + ci_id + installed_at.
  const slot = (p.slot_id ?? p.slotId ?? '').toString();
  const ci = (p.ci_id ?? p.ciId ?? '').toString();
  if (slot && ci) return `${slot}: ${ci}`;
  if (slot) return `${slot} (unverified)`;
  // Legacy / submit_cm_event.py-shaped fallback for producers that
  // don't go through the proto path.
  const category = p.category ?? p.part_category ?? '';
  const id = p.part_id ?? p.identifier ?? p.id ?? '';
  if (category && id) return `${category}: ${id}`;
  if (id || category) return `${id || category}`;
  return JSON.stringify(p).slice(0, 80);
}

// ModCompliance proto: state is a MOD_STATE_* enum. cm-service can emit
// it either as the integer value or as the name string depending on the
// JSON serializer config; handle both.
const MOD_STATE_NAMES: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'NOT_APPLICABLE',
  2: 'PENDING',
  3: 'OVERDUE',
  4: 'APPLIED',
  5: 'WAIVED',
};

function modStateLabel(state: any): string {
  if (state == null || state === '') return '';
  if (typeof state === 'number') return MOD_STATE_NAMES[state] ?? `STATE_${state}`;
  // Name string already -- strip the MOD_STATE_ prefix for terse display.
  return String(state).replace(/^MOD_STATE_/, '');
}

function modLabel(m: any): string {
  if (m == null) return 'mod';
  if (typeof m === 'string') return m;
  // ModCompliance proto: mod_id + state + (sometimes) status field.
  const id = (m.mod_id ?? m.modId ?? m.identifier ?? m.id ?? '').toString();
  const state = modStateLabel(m.state ?? m.status);
  if (id && state) return `${id} (${state})`;
  if (id) return id;
  return JSON.stringify(m).slice(0, 80);
}

export default function CmStateCard({ cm, isLoading = false }: { cm: CmState | null; isLoading?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedInstalled, setExpandedInstalled] = useState(false);
  const [expandedMods, setExpandedMods] = useState(false);
  const badge = cmStatusBadge(cm?.overall_status);
  const discrepancies = cm?.discrepancies ?? [];
  const manual = cm?.manual_discrepancies ?? [];
  const installed = cm?.installed ?? [];
  const modStatus = cm?.mod_status ?? [];
  const totalDisc = discrepancies.length + manual.length;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <ShieldAlert className="w-4 h-4 mr-2" /> Configuration Management
      </h2>

      {/* Three states: syncing (first sync not complete) -> genuinely
          empty (synced, zero rows) -> data. The syncing state must never
          fall through to the empty copy — see SyncingNotice. */}
      {isLoading && <SyncingNotice label="Syncing CM state…" />}

      {!isLoading && !cm && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No CM state for this asset yet.
        </div>
      )}

      {!isLoading && cm && (
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
              <span className="text-slate-500">Installed parts</span>
              <span className="text-slate-300">{installed.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Mods applied</span>
              <span className="text-slate-300">{modStatus.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Discrepancies</span>
              <span className="text-slate-300">
                {discrepancies.length}
                {manual.length > 0 && <span className="text-amber-400"> +{manual.length} manual</span>}
              </span>
            </div>
          </div>

          {installed.length > 0 && (
            <>
              <button
                onClick={() => setExpandedInstalled((e) => !e)}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center"
              >
                <ChevronRight className={`w-3 h-3 mr-1 transition-transform ${expandedInstalled ? 'rotate-90' : ''}`} />
                <Package className="w-3 h-3 mr-1" />
                {expandedInstalled ? 'Hide' : 'View'} installed parts ({installed.length})
              </button>
              {expandedInstalled && (
                <div className="mt-1 mb-2 space-y-1 text-[11px] max-h-32 overflow-y-auto pr-1">
                  {installed.map((p: any, i: number) => (
                    <div key={p.slot_id ?? p.slotId ?? p.part_id ?? p.identifier ?? p.id ?? i}
                         className="border-l-2 border-cyan-700 pl-2 py-0.5 text-slate-300">
                      {partLabel(p)}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {modStatus.length > 0 && (
            <>
              <button
                onClick={() => setExpandedMods((e) => !e)}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center"
              >
                <ChevronRight className={`w-3 h-3 mr-1 transition-transform ${expandedMods ? 'rotate-90' : ''}`} />
                <Wrench className="w-3 h-3 mr-1" />
                {expandedMods ? 'Hide' : 'View'} mods applied ({modStatus.length})
              </button>
              {expandedMods && (
                <div className="mt-1 mb-2 space-y-1 text-[11px] max-h-32 overflow-y-auto pr-1">
                  {modStatus.map((m: any, i: number) => (
                    <div key={m.mod_id ?? m.modId ?? m.identifier ?? m.id ?? i}
                         className="border-l-2 border-amber-700 pl-2 py-0.5 text-slate-300">
                      {modLabel(m)}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

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
