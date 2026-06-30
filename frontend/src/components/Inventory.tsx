import { useShape } from '@electric-sql/react';
import { AlertTriangle, WifiOff, Package } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ELECTRIC_URL, num } from '../hooks';

function InitialLoadSpinner() {
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
          <Package className="w-4 h-4 mr-2 animate-pulse text-emerald-500" /> Local FOB Inventory
      </h2>
      <div className="text-xs text-slate-500 animate-pulse border border-slate-700 p-2 bg-slate-800/50">
        Syncing State...
      </div>
    </div>
  );
}

function InventoryEmptyState({ scoped }: { scoped: boolean }) {
  // Honest empty-state. Replaces a pre-§C.2 mock fallback that rendered
  // hardcoded "Coolant Pumps / T/R Modules" rows whenever inventory_items
  // had zero rows — combined with the stale-cached banner that fired
  // after 30s, the panel read as "real data that's gone stale" when it
  // was actually "feature not built yet." Same family as ADR-0017's
  // no-orphan-mocks rule, applied to the empty-state path.
  //
  // 2026-06-30: two empty states now -- the asset-scoped one ("this
  // asset has no inventory rows yet -- sim hasn't ticked, or this asset
  // doesn't have a sim profile") vs the global fallback ("no rows at
  // all in the table"). Different copy so the operator can tell why.
  if (scoped) {
    return (
      <div className="text-xs text-slate-500 mt-3 border border-slate-700 bg-slate-800/50 p-2 rounded-sm">
        No per-layer inventory for this asset yet — awaiting
        <code className="text-slate-400 mx-1">asset-element-inventory</code>
        tick (sim emits on the same cadence as element telemetry).
      </div>
    );
  }
  return (
    <div className="text-xs text-slate-500 mt-3 border border-slate-700 bg-slate-800/50 p-2 rounded-sm">
      No FOB inventory data — <code className="text-slate-400">inventory_items</code> table not yet populated. Per follow-up #17.
    </div>
  );
}

function SynthesizedBadge() {
  // Mirror of TelemetryCharts' SYNTHESIZED badge -- the maintainer needs
  // a single, consistent cue across the cards that distinguishes "real
  // sustainment-feed data" from "logistics-sim modeled signal." Per
  // feedback_artifact_provenance.md: clear provenance > slightly tighter
  // chrome. The hover tooltip explains the source so the operator can
  // trust-but-verify without having to read the codebase.
  return (
    <span
      className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase rounded-sm cursor-help"
      title="Bars derived from openddil-logistics-sim's per-element health snapshot (asset-element-inventory topic). NOT a real maintenance-system inventory feed. When elements flip DEGRADED/FAULT/FAILED on the 3D drill-down, allocated climbs and the bar drops; this is the SAME signal driving the tile colors."
    >
      SYNTHESIZED
    </span>
  );
}

function InventoryTable({ rows }: { rows: any[] }) {
  return (
    <div className="space-y-3 mt-3">
        {rows.map((item: any) => {
           // Electric returns numeric columns as STRINGS (precision-
           // conservative) — coerce before any arithmetic, or "12" + "4"
           // silently becomes "124" and "0" === 0 is false.
           const available = num(item.available_count);
           const allocated = num(item.allocated_count);
           // Total capacity = everything that exists of this item, on hand
           // or out. The inventory_items schema has no max_capacity column
           // (Phase 4a decision); available + allocated is the honest total.
           const max = (available + allocated) || 1;
           const pct = Math.min(100, Math.max(0, (available / max) * 100));
           const isCritical = available === 0;

           return (
             <div key={item.id}>
                 <div className="flex justify-between text-xs mb-1 text-slate-300">
                     <span className="flex items-center">
                       {isCritical && <AlertTriangle className="w-3 h-3 text-rose-500 mr-1 animate-pulse" />}
                       {item.name}
                     </span>
                     <span className={isCritical ? "text-rose-500 font-bold" : "text-emerald-400"}>
                       {available}
                     </span>
                 </div>
                 <div className="w-full bg-slate-800 h-2 overflow-hidden border border-slate-700/50">
                     <div className={`h-2 transition-all duration-1000 ${isCritical ? 'bg-rose-500' : 'bg-emerald-500/80'}`} style={{ width: `${pct}%` }}></div>
                 </div>
             </div>
           );
        })}
    </div>
  );
}

export default function Inventory({ assetId }: { assetId?: string }) {
  // 2026-06-30: per-asset scoping. When `assetId` is set (maintainer
  // view), filter inventory_items rows by asset_id so the bars reflect
  // ONLY the sim-emitted per-layer aggregate for the focused asset.
  // When unset (any caller that still wants the legacy fleet view), the
  // filter is dropped and every row is rendered -- preserves the older
  // semantics for callers that haven't been migrated.
  //
  // Electric's `where` syntax is SQL-fragment style; quote the value so
  // a stray quote in the asset_id (none today, but defensive) can't
  // break the predicate. Empty assetId falls back to no filter.
  const { data, isLoading, lastSyncedAt } = useShape({
    url: ELECTRIC_URL,
    params: {
      table: 'inventory_items',
      ...(assetId ? { where: `asset_id = '${assetId.replace(/'/g, "''")}'` } : {}),
    },
  });

  // Initial-load-only spinner: if we have cached data from a prior session,
  // we render it immediately even while a background re-sync runs.
  const hasCachedData = data && data.length > 0;

  if (isLoading && !hasCachedData) {
    return <InitialLoadSpinner />;
  }

  // Stale-data banner: rendered ON TOP of cached data, never replacing it.
  // This is the offline-first contract: visibility of data > visibility of error.
  // §C.2 follow-up: GATED on hasCachedData — meaningless when there's no
  // real data to be stale about, and pre-§C.2 it combined with the mock
  // fallback to read as "real data that's gone wrong."
  const isStale = hasCachedData && lastSyncedAt && (Date.now() - lastSyncedAt > 30_000);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase flex items-center justify-between">
          <div className="flex items-center">
            <Package className="w-4 h-4 mr-2 text-emerald-500" /> Local FOB Inventory
            {hasCachedData && <SynthesizedBadge />}
          </div>
          {!isLoading && hasCachedData && !isStale && <span className="text-[10px] text-emerald-500 flex items-center">SYNCED</span>}
          {isLoading && hasCachedData && <span className="text-[10px] text-amber-500 flex items-center animate-pulse">SYNCING</span>}
      </h2>

      {isStale && (
        <div className="mt-2 text-[10px] bg-rose-900/30 text-rose-400 border border-rose-800 p-1 flex items-center rounded">
          <WifiOff size={12} className="mr-1" />
          <span>Cached — last synced {formatDistanceToNow(lastSyncedAt)} ago</span>
        </div>
      )}

      {hasCachedData ? <InventoryTable rows={data} /> : <InventoryEmptyState scoped={!!assetId} />}
    </div>
  );
}
