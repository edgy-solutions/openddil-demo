// =============================================================================
// HqDigitalTwin — enterprise fleet tree
// =============================================================================
// Phase 4c rewrite. Was a hardcoded EUCOM/INDO-PACOM theater tree (the
// pipeline has no theater/region hierarchy). Now a real fleet tree: every
// asset in telemetry_latest_state, grouped by platform family, each leaf
// showing the asset's real CM overall_status + logistics overall_severity.
// Expandable by family.
import { Globe, ChevronRight } from 'lucide-react';
import { useFleetAssets, useAllCmState, useAllLogisticsStatus } from '../../hooks';
import { platformFamily, shortSeverity, severityHeatClass } from '../../lib/fleetAggregates';
import { cmStatusBadge } from '../CmStateCard';

export default function HqDigitalTwin({ wanActive }: { wanActive: boolean }) {
  const fleet = useFleetAssets();
  const cm = useAllCmState();
  const logistics = useAllLogisticsStatus();

  const cmByAsset = new Map(cm.data.map((c) => [c.asset_id, c.overall_status]));
  const sevByAsset = new Map(logistics.data.map((l) => [l.asset_id, l.overall_severity]));

  // Group the fleet by platform family.
  const families = new Map<string, typeof fleet.data>();
  for (const a of fleet.data) {
    const fam = platformFamily(a.platform_variant);
    families.set(fam, [...(families.get(fam) ?? []), a]);
  }
  const familyList = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className={`panel flex-1 flex flex-col overflow-hidden p-3 transition-colors duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`}>
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Globe className={`w-4 h-4 mr-2 transition-colors ${wanActive ? 'text-emerald-400' : 'text-rose-500'}`} />
        Enterprise Fleet Tree
        <span className="ml-auto text-[10px] text-slate-500 normal-case tracking-normal">
          {fleet.data.length} asset{fleet.data.length === 1 ? '' : 's'}
        </span>
      </h2>

      <div className="flex-1 overflow-y-auto text-xs font-mono space-y-1 pr-2 pb-2 select-none">
        {familyList.length === 0 && (
          <div className="text-slate-500">No assets in the pipeline.</div>
        )}
        {familyList.map(([family, assets]) => (
          <details key={family} open className="mb-2">
            <summary className="flex items-center p-1.5 bg-slate-800/50 hover:bg-slate-800 border border-slate-700 rounded transition-colors group cursor-pointer">
              <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
              <span className="flex-1 font-bold text-slate-200 tracking-widest">{family}</span>
              <span className="text-[9px] text-slate-500">{assets.length}</span>
            </summary>
            <div className="tree-node space-y-1 py-1 mt-1">
              {assets.map((a) => {
                const cmBadge = cmStatusBadge(cmByAsset.get(a.asset_id));
                const sev = sevByAsset.get(a.asset_id);
                return (
                  <div key={a.asset_id} className="flex items-center justify-between p-1 hover:bg-slate-800 rounded text-[10px]">
                    <span className="text-slate-300">{a.callsign || a.asset_id}</span>
                    <span className="flex items-center gap-1">
                      <span className={`px-1 py-px rounded-sm border ${cmBadge.cls}`}>{cmBadge.label}</span>
                      <span className={`px-1 py-px rounded-sm border ${severityHeatClass(sev)}`}>{shortSeverity(sev)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
