// =============================================================================
// WorkOrders — actionable maintenance items, derived from CM discrepancies
// =============================================================================
// Phase 4c rewrite. Was a hardcoded WO list passed in as a prop. There is
// no work-orders table in the pipeline — but cm-service's CM discrepancies
// each carry a `recommended_action`, which IS the actionable maintenance
// item. This panel rolls those up across the fleet from asset_cm_state
// (useAllCmState): one row per discrepancy that has a recommended action.
//
// The link2 "system freeze" overlay is kept as a UI affordance — see the
// Phase 4c checkpoint finding on the DDIL link/buffer wiring.
import { ClipboardList, Lock } from 'lucide-react';
import { useAllCmState } from '../../hooks';

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

function statusClass(status: string): string {
  switch (status) {
    case 'CONFIG_STATUS_NOT_MISSION_CAPABLE': return 'bg-rose-500/20 text-rose-400 border-rose-500/50';
    case 'CONFIG_STATUS_MAJOR_DISCREPANCY': return 'bg-orange-500/20 text-orange-400 border-orange-500/50';
    case 'CONFIG_STATUS_MINOR_DISCREPANCY': return 'bg-amber-500/20 text-amber-400 border-amber-500/50';
    default: return 'bg-slate-800 text-slate-400 border-slate-700';
  }
}

export default function WorkOrders({ link2 }: { link2: boolean }) {
  const cm = useAllCmState();

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
        <ClipboardList className="w-4 h-4 mr-2 text-cyan-400" /> Regional Work Orders
        <span className="ml-auto text-[10px] text-slate-500 normal-case tracking-normal">
          from CM discrepancies
        </span>
      </h2>

      {/* System Freeze Overlay — UI affordance driven by the link2 toggle. */}
      {!link2 && (
        <div className="absolute inset-0 bg-rose-950/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center border-2 border-rose-500 mt-12 mx-3 mb-3">
          <Lock className="w-8 h-8 text-rose-500 mb-2" />
          <span className="font-bold text-rose-400 tracking-widest text-sm">SYSTEM FREEZE</span>
          <span className="text-[10px] text-rose-300 mt-1">WAITING FOR HQ WAN...</span>
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
                  <span className={`px-1.5 py-0.5 rounded text-[9px] border ${statusClass(it.overall_status)}`}>
                    {it.overall_status.replace('CONFIG_STATUS_', '').replace(/_/g, ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
