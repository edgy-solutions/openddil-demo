// =============================================================================
// MunitionsLoadoutCard -- per-launcher munitions inventory
// =============================================================================
// Rendered on the maintainer view when the selected asset is a LAUNCHER
// (asset_class === 'LAUNCHER'). Shows per-store bars: munition_type,
// available count, expended count, capacity bar.
//
// Data source: useMunitionsStockpile() -> filter to selectedAssetId via
// stockpileForLauncher(). Purely derived, no server-side change.
//
// Empty state: a launcher with no capabilities in the roster (shouldn't
// happen if the classifier said LAUNCHER -- LAUNCHER means "present in
// asset_capability_state" -- but defensive path is present).
// =============================================================================
import { Target, Package } from 'lucide-react';
import { useMunitionsStockpile, stockpileForLauncher } from '../hooks';
import { displayMunitionType } from '../lib/munitionType';

export default function MunitionsLoadoutCard({
  assetId,
}: {
  assetId: string | null | undefined;
}) {
  const stockpile = useMunitionsStockpile();
  const rows = stockpileForLauncher(stockpile.entries, assetId);

  if (!assetId) return null;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Target className="w-4 h-4 mr-2 text-amber-400" />
        Munitions Loadout
        <span
          className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase rounded-sm cursor-help"
          title={
            "Initial ammo derived from the max value observed on the wire " +
            "during this browser session (StrikeCapability snapshots). " +
            "Expended = initial - current."
          }
        >
          DERIVED
        </span>
      </h2>

      {rows.length === 0 ? (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No StrikeCapability snapshot for this launcher yet.
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
