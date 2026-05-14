// =============================================================================
// SyncingNotice — "first sync not complete" indicator for shape panels
// =============================================================================
// Phase 4c.5 cold-start fix. A where-filtered per-asset ElectricSQL shape
// has a window between mount and first-sync-complete where it has no rows
// yet but is NOT genuinely empty. Without a distinct syncing state the
// panel renders its genuinely-empty copy ("No X state for this asset
// yet") during that window — wrong, and exactly what a maintainer hits
// opening the COP cold at shift start.
//
// Panels render this while `isLoading` (useShape's first-sync flag is
// threaded through the hooks' ShapeResult), and only fall through to the
// genuinely-empty copy once the first sync has completed with zero rows.
export function SyncingNotice({ label }: { label?: string }) {
  return (
    <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2 rounded-sm flex items-center gap-2">
      <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse shrink-0" />
      <span className="animate-pulse">{label ?? 'Syncing…'}</span>
    </div>
  );
}

export default SyncingNotice;
