// =============================================================================
// HqDigitalTwin — enterprise fleet tree
// =============================================================================
// Phase 4c rewrite. Was a hardcoded EUCOM/INDO-PACOM theater tree (the
// pipeline has no theater/region hierarchy). Now a real fleet tree: every
// asset in telemetry_latest_state, grouped by platform family, each leaf
// showing the asset's real CM overall_status + logistics overall_severity.
// Expandable by family.
//
// 2026-07-13 (Phase 5): switched from useFleetAssets to useClassifiedFleet
// so we can segregate MUNITION-class in-flight rows. Fired munitions are
// transient (~seconds until impact) and share platform_variants with
// their launcher hardware, so leaving them merged with the "real" fleet
// polluted the tree with N transient rows per firing that would
// disappear on the next TTL sweep. Now they live in their own
// "IN FLIGHT" collapsed group at the bottom of the tree.
import { useMemo } from 'react';
import { Globe, ChevronRight, Rocket } from 'lucide-react';
import { useClassifiedFleet, useAllCmState, useAllLogisticsStatus } from '../../hooks';
import { platformFamily, shortSeverity, severityHeatClass } from '../../lib/fleetAggregates';
import { assetCallsign } from '../../lib/assetLabel';
import { cmStatusBadge } from '../CmStateCard';
import { dedupFirings } from '../../lib/munitionAsset';

export default function HqDigitalTwin({ wanActive }: { wanActive: boolean }) {
  const fleet = useClassifiedFleet();
  const cm = useAllCmState();
  const logistics = useAllLogisticsStatus();

  const cmByAsset = new Map(cm.data.map((c) => [c.asset_id, c.overall_status]));
  const sevByAsset = new Map(logistics.data.map((l) => [l.asset_id, l.overall_severity]));

  // Split classified fleet into hardware vs. in-flight munitions. The
  // hardware side is what belongs in the "fleet" tree conceptually --
  // in-flight munitions are engagement activity, not enterprise assets.
  const { hardware, inflight } = useMemo(() => {
    const hw: typeof fleet.data = [];
    const inf: typeof fleet.data = [];
    for (const a of fleet.data) {
      if (a.asset_class === 'MUNITION') inf.push(a);
      else hw.push(a);
    }
    // Dedup the in-flight rows down to one representative per firing.
    // Two rows per firing (delivery vehicle + seeker payload) would
    // double-count engagement activity otherwise.
    return { hardware: hw, inflight: dedupFirings(inf) };
  }, [fleet.data]);

  // Group the hardware fleet by platform family.
  const families = new Map<string, typeof hardware>();
  for (const a of hardware) {
    const fam = platformFamily(a.platform_variant);
    families.set(fam, [...(families.get(fam) ?? []), a]);
  }
  const familyList = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  /*
   * Sizing: shrink-0 + max-h on the panel, overflow-y-auto on the
   * tree list. The previous flex-1 in the HQ right column (which is
   * a flex-col with overflow-y-auto) collapsed to header-only because
   * the parent doesn't define a height for flex-1 to fill — the tree
   * content rendered with effectively zero height and the Enterprise
   * Fleet Tree appeared "buried" under its header. Cap at 500px so
   * the tree shows multiple platform families on first arrival
   * without scrolling-and-hunting; the family details elements
   * scroll within.
   */
  return (
    <div className={`panel shrink-0 flex flex-col max-h-[500px] overflow-hidden p-3 transition-colors duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`}>
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Globe className={`w-4 h-4 mr-2 transition-colors ${wanActive ? 'text-emerald-400' : 'text-rose-500'}`} />
        Enterprise Fleet Tree
        <span className="ml-auto text-[10px] text-slate-500 normal-case tracking-normal">
          {hardware.length} asset{hardware.length === 1 ? '' : 's'}
          {inflight.length > 0 && (
            <span className="ml-2 text-amber-400">
              · {inflight.length} in flight
            </span>
          )}
        </span>
      </h2>

      <div className="overflow-y-auto text-xs font-mono space-y-1 pr-2 pb-2 select-none">
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
                const callsign = assetCallsign(a);
                return (
                  <div key={a.asset_id} className="flex items-center justify-between gap-2 p-1 hover:bg-slate-800 rounded text-[10px]">
                    {/* asset_id is the distinguishing identifier; the sim-a
                        test feed reuses one shared callsign across assets. */}
                    <span className="min-w-0 flex-1 truncate text-slate-300" title={a.asset_id}>
                      {a.asset_id}
                      {callsign && <span className="opacity-60"> · {callsign}</span>}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className={`px-1 py-px rounded-sm border ${cmBadge.cls}`}>{cmBadge.label}</span>
                      <span className={`px-1 py-px rounded-sm border ${severityHeatClass(sev)}`}>{shortSeverity(sev)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        ))}

        {/* IN FLIGHT group -- engagement activity, not enterprise assets.
            Defaults collapsed because rows here are transient (~seconds).
            Each row shows the firing's parent launcher when we could
            derive it; otherwise falls back to the munition's asset_id.
            No CM / severity badges: fired munitions have neither. */}
        {inflight.length > 0 && (
          <details className="mb-2">
            <summary className="flex items-center p-1.5 bg-amber-950/30 hover:bg-amber-950/50 border border-amber-900/50 rounded transition-colors group cursor-pointer">
              <ChevronRight className="w-3 h-3 mr-1 text-amber-500 group-open:rotate-90 transition-transform" />
              <Rocket className="w-3 h-3 mr-1 text-amber-400" />
              <span className="flex-1 font-bold text-amber-300 tracking-widest">IN FLIGHT</span>
              <span className="text-[9px] text-amber-500">{inflight.length}</span>
            </summary>
            <div className="tree-node space-y-1 py-1 mt-1">
              {inflight.map((a) => {
                const munitionType = a.platform_variant ?? 'UNKNOWN';
                return (
                  <div
                    key={a.asset_id}
                    className="flex items-center justify-between gap-2 p-1 hover:bg-slate-800 rounded text-[10px]"
                    title={a.asset_id}
                  >
                    <span className="min-w-0 flex-1 truncate text-slate-300">
                      <span className="text-amber-300">{munitionType}</span>
                      {a.firing_sequence !== null && (
                        <span className="text-slate-500"> #{a.firing_sequence}</span>
                      )}
                      {a.parent_launcher_id && (
                        <span className="opacity-60"> ← {a.parent_launcher_id}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
