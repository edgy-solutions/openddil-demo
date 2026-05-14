import { useShape } from '@electric-sql/react';
import { AlertTriangle, WifiOff, Package } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const ELECTRIC_URL = import.meta.env.VITE_ELECTRIC_URL ?? 'http://localhost:5133/v1/shape';

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

function InventoryTable({ rows }: { rows: any[] }) {
  const items = rows && rows.length > 0 ? rows : [
    { id: "1", name: "Coolant Pumps", available_count: 0, allocated_count: 10 },
    { id: "2", name: "T/R Modules", available_count: 14, allocated_count: 16 }
  ];

  return (
    <div className="space-y-3 mt-3">
        {items.map((item: any) => {
           // Total capacity = everything that exists of this item, on hand or
           // out. The inventory_items schema has no max_capacity column
           // (Phase 4a decision); available + allocated is the honest total.
           const max = (item.available_count + item.allocated_count) || 1;
           const pct = Math.min(100, Math.max(0, (item.available_count / max) * 100));
           const isCritical = item.available_count === 0;
           
           return (
             <div key={item.id}>
                 <div className="flex justify-between text-xs mb-1 text-slate-300">
                     <span className="flex items-center">
                       {isCritical && <AlertTriangle className="w-3 h-3 text-rose-500 mr-1 animate-pulse" />}
                       {item.name}
                     </span>
                     <span className={isCritical ? "text-rose-500 font-bold" : "text-emerald-400"}>
                       {item.available_count}
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

export default function Inventory() {
  const { data, isLoading, lastSyncedAt } = useShape({
    url: ELECTRIC_URL,
    params: { table: 'inventory_items' },
  });

  // Initial-load-only spinner: if we have cached data from a prior session,
  // we render it immediately even while a background re-sync runs.
  const hasCachedData = data && data.length > 0;

  if (isLoading && !hasCachedData) {
    return <InitialLoadSpinner />;
  }

  // Stale-data banner: rendered ON TOP of cached data, never replacing it.
  // This is the offline-first contract: visibility of data > visibility of error.
  const isStale = lastSyncedAt && (Date.now() - lastSyncedAt > 30_000);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase flex items-center justify-between">
          <div className="flex items-center">
            <Package className="w-4 h-4 mr-2 text-emerald-500" /> Local FOB Inventory
          </div>
          {!isLoading && !isStale && <span className="text-[10px] text-emerald-500 flex items-center">SYNCED</span>}
          {isLoading && hasCachedData && <span className="text-[10px] text-amber-500 flex items-center animate-pulse">SYNCING</span>}
      </h2>
      
      {isStale && (
        <div className="mt-2 text-[10px] bg-rose-900/30 text-rose-400 border border-rose-800 p-1 flex items-center rounded">
          <WifiOff size={12} className="mr-1" />
          <span>Cached — last synced {formatDistanceToNow(lastSyncedAt)} ago</span>
        </div>
      )}

      <InventoryTable rows={data} />
    </div>
  );
}