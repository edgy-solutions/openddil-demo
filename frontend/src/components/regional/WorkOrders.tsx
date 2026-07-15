// =============================================================================
// WorkOrders — regional CM recommendations panel (rendered as "Regional CM
// Recommendations"; file/component name retains "WorkOrders" for git-blame
// continuity)
// =============================================================================
// Phase 4c rewrite. Was a hardcoded WO list passed in as a prop. There is
// no work-orders table in the pipeline — but cm-service's CM discrepancies
// each carry a `recommended_action`, which IS the actionable maintenance
// item. This panel rolls those up across the fleet from asset_cm_state
// (useAllCmState): one row per discrepancy that has a recommended action.
//
// Rendered title was "Regional Work Orders" through Phase 6c. Renamed per
// ADR-0017 honesty discipline (mock components self-identify): the panel
// does not talk to a work-order system; the data is CM-derived. The "Work
// Orders" framing will be earned back when the ALCS/EAGLE egress phase
// delivers a real work-orders topic — at that point this component (or a
// successor) reads from that topic and the title becomes accurate again.
//
// The "system freeze" overlay is driven by the REAL hq-link state
// (useEdgeBuffer().hq_link_severed) as of Phase 4c.5 — when the edge->HQ
// link is genuinely severed, the panel shows the freeze.
import { ClipboardList, Lock } from 'lucide-react';
import { useAllCmState, useEdgeBuffer } from '../../hooks';
import { cmStatusBadge } from '../CmStateCard';

interface ActionItem {
  key: string;
  asset_id: string;
  description: string;
  recommended_action: string;
  overall_status: string;
}

// Worst-first ordering by the owning asset's CM status.
const CM_RANK: Record<string, number> = {
  CONFIG_STATUS_NOT_MISSION_CAPABLE: 4,
  CONFIG_STATUS_MAJOR_DISCREPANCY: 3,
  CONFIG_STATUS_MINOR_DISCREPANCY: 2,
  CONFIG_STATUS_IN_COMPLIANCE: 1,
};

// Label + color come from the shared cmStatusBadge() helper (CmStateCard),
// so the CM status renders identically here, on the maintainer CM card,
// and in the HQ recommendations panel. Previously this panel re-derived
// the label via .replace() (which produced the overclaiming "NOT MISSION
// CAPABLE") and painted it rose -- a divergence from the maintainer card
// that survived the ADR-0026 label fix because it was a separate code
// path. Single source of truth prevents the same drift recurring.

export default function WorkOrders() {
  const cm = useAllCmState();
  const { status } = useEdgeBuffer();
  const severed = status?.hq_link_severed ?? false;

  const items: ActionItem[] = [];
  for (const row of cm.data) {
    const all = [...(row.discrepancies ?? []), ...(row.manual_discrepancies ?? [])];
    all.forEach((d: any, i: number) => {
      if (!d?.recommended_action) return;
      items.push({
        key: `${row.asset_id}:${d.discrepancy_id ?? i}`,
        asset_id: row.asset_id,
        description: d.description ?? d.discrepancy_id ?? 'discrepancy',
        recommended_action: d.recommended_action,
        overall_status: row.overall_status,
      });
    });
  }
  items.sort((a, b) => (CM_RANK[b.overall_status] ?? 0) - (CM_RANK[a.overall_status] ?? 0));

  return (
    <div className="panel h-64 shrink-0 flex flex-col overflow-hidden p-3 relative">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <ClipboardList className="w-4 h-4 mr-2 text-cyan-400" /> Regional CM Recommendations
        <span className="ml-auto text-[10px] text-slate-500 normal-case tracking-normal">
          from CM discrepancies
        </span>
      </h2>

      {/* System Freeze Overlay — driven by the REAL hq-link sever state. */}
      {severed && (
        <div className="absolute inset-0 bg-rose-950/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center border-2 border-rose-500 mt-12 mx-3 mb-3">
          <Lock className="w-8 h-8 text-rose-500 mb-2" />
          <span className="font-bold text-rose-400 tracking-widest text-sm">SYSTEM FREEZE</span>
          <span className="text-[10px] text-rose-300 mt-1">EDGE→HQ LINK SEVERED</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {items.length === 0 && (
          <div className="text-xs text-slate-500 p-2">
            No actionable CM discrepancies across the fleet.
          </div>
        )}
        <table className="w-full text-left text-xs font-mono">
          <tbody className="text-slate-300 divide-y divide-slate-800">
            {items.map((it) => (
              <tr key={it.key} className="hover:bg-slate-800/50 transition-colors">
                <td className="py-2 align-top">
                  <div className="text-cyan-400">{it.asset_id}</div>
                  <div className="text-slate-400 text-[11px]">{it.description}</div>
                  <div className="text-slate-500 text-[11px]">{it.recommended_action}</div>
                </td>
                <td className="text-right align-top">
                  {(() => {
                    const badge = cmStatusBadge(it.overall_status);
                    return (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] border ${badge.cls}`}>
                        {badge.label}
                      </span>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
