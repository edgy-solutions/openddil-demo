// =============================================================================
// HqWorkOrders — enterprise CM recommendations panel (rendered as
// "Enterprise CM Recommendations"; file/component name retains "WorkOrders"
// for git-blame continuity)
// =============================================================================
// Phase 4c rewrite. Was a hardcoded WO list. Like the regional WorkOrders,
// there is no work-orders table in the pipeline — but CM discrepancies
// carry a `recommended_action`. This panel rolls those up enterprise-wide
// from asset_cm_state (useAllCmState), worst CM status first.
//
// Rendered title was "ALCS Enterprise Logistics" through Phase 6c. Renamed
// per ADR-0017 honesty discipline (mock components self-identify): the
// panel does not talk to an ALCS work-order system; the data is CM-derived.
// The "ALCS" / "Work Orders" titles will be earned back when the ALCS/
// EAGLE egress phase delivers real enterprise work-order propagation —
// at that point this component (or a successor) reads from a real
// work-orders topic, and the title becomes accurate again.
import { Layers } from 'lucide-react';
import { useAllCmState } from '../../hooks';

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
    default: return 'bg-slate-800 text-slate-500 border-slate-700';
  }
}

export default function HqWorkOrders({ wanActive }: { wanActive: boolean }) {
  const cm = useAllCmState();

  const items = cm.data
    .flatMap((row) =>
      [...(row.discrepancies ?? []), ...(row.manual_discrepancies ?? [])]
        .filter((d: any) => d?.recommended_action)
        .map((d: any, i: number) => ({
          key: `${row.asset_id}:${d.discrepancy_id ?? i}`,
          asset_id: row.asset_id,
          recommended_action: d.recommended_action as string,
          overall_status: row.overall_status,
        })),
    )
    .sort((a, b) => (CM_RANK[b.overall_status] ?? 0) - (CM_RANK[a.overall_status] ?? 0));

  return (
    <div className={`panel shrink-0 flex flex-col max-h-[280px] overflow-hidden p-3 relative transition-colors duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`}>
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Layers className={`w-4 h-4 mr-2 transition-colors ${wanActive ? 'text-cyan-400' : 'text-rose-500'}`} />
        Enterprise CM Recommendations
        <span className="ml-auto text-[10px] text-slate-500 normal-case tracking-normal">
          from CM discrepancies
        </span>
      </h2>

      <div className="flex-1 overflow-auto">
        {items.length === 0 && (
          <div className="text-xs text-slate-500 p-2">
            No actionable CM discrepancies enterprise-wide.
          </div>
        )}
        <table className="w-full text-left text-xs font-mono">
          <tbody className="text-slate-300 divide-y divide-slate-800">
            {items.map((it) => (
              <tr key={it.key} className="hover:bg-slate-800/50">
                <td className="py-2 align-top">
                  <div className="text-cyan-400">{it.asset_id}</div>
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
