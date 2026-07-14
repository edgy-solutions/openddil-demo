// =============================================================================
// MunitionsLoadoutCard -- per-launcher munitions inventory
// =============================================================================
// Renders ONLY when the selected asset is a LAUNCHER (asset_class ===
// 'LAUNCHER'). Sensor / facility / platform / munition selections get
// nothing at all -- munitions loadout is a launcher-only concern; the
// old always-render behavior surfaced "no weapons-capability snapshot
// for this launcher yet" on every non-launcher selection, which read
// as if launcher state were broken.
//
// Shows per-store bars: munition_type, available count, expended
// count, capacity bar. Optional IN FLIGHT pill in the card header
// when the selected launcher has any deduped-per-firing munitions
// currently airborne.
//
// Data sources:
//   * useClassifiedFleet   -- asset_class discriminator for the
//                             render-or-hide gate
//   * useMunitionsStockpile -- per-store entries filtered to selectedAssetId
// =============================================================================
import { useMemo } from 'react';
import { Target, Package, Rocket } from 'lucide-react';
import {
  useMunitionsStockpile,
  useClassifiedFleet,
  stockpileForLauncher,
} from '../hooks';
import { displayMunitionType } from '../lib/munitionType';
import { dedupFirings } from '../lib/munitionAsset';

export default function MunitionsLoadoutCard({
  assetId,
}: {
  assetId: string | null | undefined;
}) {
  const stockpile = useMunitionsStockpile();
  const rows = stockpileForLauncher(stockpile.entries, assetId);
  const fleet = useClassifiedFleet();

  // Class of the selected asset drives the render-or-hide gate. We
  // consult useClassifiedFleet rather than checking rows.length so
  // a launcher whose weapons-capability feed hasn't yet arrived
  // still renders the card (with its empty-state) -- the card
  // legitimately signals "this launcher has no snapshot yet" only
  // for actual launchers, not for sensors that will never have one.
  const selectedClass = useMemo(() => {
    if (!assetId) return null;
    return fleet.data.find((a) => a.asset_id === assetId)?.asset_class ?? null;
  }, [fleet.data, assetId]);

  // Live count of in-flight munitions attributable to THIS launcher --
  // MUNITION-class fleet rows whose parent_launcher_id matches, deduped
  // to one representative per firing (delivery vehicle + seeker payload
  // collapse). Zero when nothing is airborne right now.
  const inflightFromThisLauncher = useMemo(() => {
    if (!assetId) return 0;
    const munitions = fleet.data.filter(
      (a) => a.asset_class === 'MUNITION' && a.parent_launcher_id === assetId,
    );
    return dedupFirings(munitions).length;
  }, [fleet.data, assetId]);

  // Hide entirely for non-launcher selections. The card exists to
  // convey per-store weapons state; a sensor / facility / platform
  // has no stores to render.
  if (!assetId || selectedClass !== 'LAUNCHER') return null;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Target className="w-4 h-4 mr-2 text-amber-400" />
        Munitions Loadout
        <span
          className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase rounded-sm cursor-help"
          title={
            "Initial ammo derived from the max value observed on the wire " +
            "during this browser session (weapons-capability snapshots). " +
            "Expended = initial - current."
          }
        >
          DERIVED
        </span>
        {inflightFromThisLauncher > 0 && (
          <span
            className="ml-auto flex items-center text-[10px] font-mono tracking-widest px-1.5 py-0.5 border border-amber-500/60 bg-amber-500/10 text-amber-300 rounded-sm"
            title="Munitions currently in flight from this launcher (deduped per firing)"
          >
            <Rocket className="w-3 h-3 mr-1 animate-pulse" />
            {inflightFromThisLauncher} IN FLIGHT
          </span>
        )}
      </h2>

      {rows.length === 0 ? (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No weapons-capability snapshot for this launcher yet.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const pctAvail = r.initial_ammo > 0
              ? Math.max(0, Math.min(100, (r.current_ammo / r.initial_ammo) * 100))
              : 0;
            const isDepleted = r.current_ammo === 0 && r.initial_ammo > 0;
            const isLow = !isDepleted && pctAvail <= 25;
            const barClass = isDepleted
              ? 'bg-rose-500'
              : isLow
                ? 'bg-amber-500'
                : 'bg-emerald-500/80';
            const availClass = isDepleted
              ? 'text-rose-400 font-bold'
              : isLow
                ? 'text-amber-400'
                : 'text-emerald-400';
            return (
              <div key={r.capability_id}>
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="flex items-center text-slate-300">
                    <Package className="w-3 h-3 mr-1 text-slate-500" />
                    <span className="truncate" title={r.munition_type}>
                      {displayMunitionType(r.munition_type)}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums">
                    <span className={availClass}>{r.current_ammo}</span>
                    <span className="text-slate-500"> / {r.initial_ammo}</span>
                    {r.expended > 0 && (
                      <span className="text-slate-500 ml-2">
                        ({r.expended} fired)
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-2 overflow-hidden border border-slate-700/50">
                  <div
                    className={`h-2 transition-all duration-1000 ${barClass}`}
                    style={{ width: `${pctAvail}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
