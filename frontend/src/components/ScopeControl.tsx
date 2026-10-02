// =============================================================================
// ScopeControl — shared scope selector/label for every tier
// =============================================================================
// The control's shape is decided ONLY by the COUNT of scopes in `available`
// (itself already derived from the shapes the signed-in subject receives),
// never by tier name:
//   available.length > 1  -> a <select>, one <option> per scope.
//   available.length === 1 -> a static label naming that one scope (a
//     <span data-testid="scope-label">), regardless of `selected`. No
//     <select>, no dropdown arrow, no "(only X observed)" hint.
//   available.length === 0 -> `emptyText` rendered the same static way.
// The same component renders on every tier; `variant` only changes chrome
// (header = EdgePulldown's old look, compact = RegionPulldown's).
interface ScopeControlProps {
  label: string;
  available: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  emptyText: string;
  variant: 'header' | 'compact';
}

export type ScopeMode = 'selector' | 'label' | 'empty';

/** The count-based rule in one place, so the component and its tests share
 *  a single source of truth instead of two copies of the same branching. */
export function scopeMode(available: string[]): ScopeMode {
  if (available.length > 1) return 'selector';
  if (available.length === 1) return 'label';
  return 'empty';
}

export default function ScopeControl({
  label, available, selected, onSelect, emptyText, variant,
}: ScopeControlProps) {
  const mode = scopeMode(available);

  if (mode !== 'selector') {
    const text = mode === 'label' ? available[0] : emptyText;
    return variant === 'header' ? (
      <div className="flex flex-col">
        <label className="text-[10px] text-slate-400 tracking-wider mb-1">
          {label}
        </label>
        <span data-testid="scope-label" className="text-sm text-slate-200 py-1.5">
          {text}
        </span>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">
          {label}
        </span>
        <span data-testid="scope-label" className="text-slate-300 text-[11px]">
          {text}
        </span>
      </div>
    );
  }

  const value = selected ?? available[0];

  if (variant === 'header') {
    return (
      <div className="flex flex-col">
        <label className="text-[10px] text-slate-400 tracking-wider mb-1">
          {label}
        </label>
        <div className="relative">
          <select
            value={value}
            onChange={(e) => onSelect(e.target.value)}
            className="appearance-none w-44 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 cursor-pointer"
          >
            {available.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
            <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
            </svg>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        className="bg-slate-800 border border-slate-700 text-slate-200 text-[11px] rounded px-2 py-1"
      >
        {available.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
    </div>
  );
}
