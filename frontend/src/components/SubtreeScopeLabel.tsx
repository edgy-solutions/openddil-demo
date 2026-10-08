// =============================================================================
// SubtreeScopeLabel — read-only scope row for an intermediate tier
// =============================================================================
// An intermediate tier rolls up its child tiers; there is nothing to choose
// between, so the row names them and offers no selector. Same markup as
// ScopeControl's compact label mode.
interface SubtreeScopeLabelProps {
  tiers: string[];
  emptyText: string;
}

export function SubtreeScopeLabel({ tiers, emptyText }: SubtreeScopeLabelProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">
        Subtree
      </span>
      <span data-testid="scope-label" className="text-slate-300 text-[11px]">
        {tiers.length > 0 ? tiers.join(' · ') : emptyText}
      </span>
    </div>
  );
}
