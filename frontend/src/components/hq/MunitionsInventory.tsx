// =============================================================================
// MunitionsInventory -- theater-wide munitions rollup by type
// =============================================================================
// Phase 3 of the munitions taxonomy work (2026-07-13). Sibling panel to
// FORCE POSTURE (which handles HARDWARE readiness); this one is the
// EFFECTOR inventory dimension of the commander's air-defense picture.
//
// Reads useMunitionsStockpile() -- a frontend-derived rollup from
// asset_capability_state (per-launcher weapons-capability snapshots).
// Initial ammo values are derived via a running max-seen accumulator;
// expended values are `initial - current` per (launcher, capability)
// rolled up to munition_type.
//
// Known operational quirks (surfaced via the SYNTHESIZED-style badge):
//   * A page reload zeroes the max-seen accumulator, so post-reload
//     the "expended" count restarts from the reload point. The Reset
//     button surfaces this explicitly so the operator understands
//     what they're seeing.
//   * A cluster flush + fresh scenario resets the pipeline but not
//     the frontend cache. Click Reset after a flush to realign.
// =============================================================================
import { RefreshCw, Target } from 'lucide-react';
import { useMunitionsStockpile } from '../../hooks';
import { displayMunitionType } from '../../lib/munitionType';

function ProvenanceBadge() {
  return (
    <span
      className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase rounded-sm cursor-help"
      title={
        "Available = current ammo per launcher summed by munition type. " +
        "Expended = (max observed ammo) - (current), summed by type. " +
        "Max observed is tracked client-side across the session; " +
        "click Reset after a cluster flush or scenario change to realign."
      }
    >
      DERIVED
    </span>
  );
}

export default function MunitionsInventory() {
  const stockpile = useMunitionsStockpile();
  const empty = stockpile.byType.length === 0;

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2 flex items-center justify-between">
        <span className="flex items-center">
          <Target className="w-4 h-4 mr-2 text-amber-400" />
          Munitions Inventory (theater)
          <ProvenanceBadge />
        </span>
        <button
          type="button"
          onClick={stockpile.reset}
          className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1 border border-slate-700 px-1.5 py-0.5 rounded-sm"
          title="Zero the max-seen accumulator (post-flush / new-scenario realignment)"
        >
          <RefreshCw className="w-3 h-3" />
          RESET
        </button>
      </h2>

      {empty ? (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
          No weapons-capability snapshots yet -- awaiting first emission.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 text-[11px] font-mono">
            <div className="text-[10px] text-slate-500 tracking-widest uppercase">TYPE</div>
            <div className="text-[10px] text-slate-500 tracking-widest uppercase text-right">AVAIL</div>
            <div className="text-[10px] text-slate-500 tracking-widest uppercase text-right">EXPD</div>
            <div className="text-[10px] text-slate-500 tracking-widest uppercase text-right">INIT</div>
            {stockpile.byType.map((row) => {
              // Color the available count by consumption fraction: full
              // = emerald, drained past 75% = amber, fully drained = rose.
              const drainFrac = row.initial > 0
                ? (row.initial - row.available) / row.initial
                : 0;
              const availClass = row.available === 0
                ? 'text-rose-400 font-bold'
                : drainFrac > 0.75
                  ? 'text-amber-400'
                  : 'text-emerald-400';
              return (
                <div key={row.munition_type} className="contents">
                  <div className="text-slate-300 truncate" title={row.munition_type}>
                    {displayMunitionType(row.munition_type)}
                    <span className="text-slate-500 ml-2 text-[10px]">
                      ({row.launcher_count} lncher{row.launcher_count === 1 ? '' : 's'})
                    </span>
                  </div>
                  <div className={`text-right tabular-nums ${availClass}`}>{row.available}</div>
                  <div className="text-right tabular-nums text-slate-300">{row.expended}</div>
                  <div className="text-right tabular-nums text-slate-500">{row.initial}</div>
                </div>
              );
            })}
            {/* Totals row */}
            <div className="border-t border-slate-800 pt-1 mt-1 text-slate-400 tracking-widest text-[10px] uppercase">
              TOTAL
            </div>
            <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-emerald-400 font-bold">
              {stockpile.totals.available}
            </div>
            <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-slate-300">
              {stockpile.totals.expended}
            </div>
            <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-slate-500">
              {stockpile.totals.initial}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
