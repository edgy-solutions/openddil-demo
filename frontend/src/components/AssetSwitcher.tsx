// =============================================================================
// AssetSwitcher — identity card + asset picker overlaid on the maintainer 3D view
// =============================================================================
// Collapsed: a glass identity card for the selected asset with a switch button.
// Open: a glass panel with a filter box, the fleet tier summary, and a listbox
// of assets. `/` opens, Up/Down move, Enter selects, Escape closes.
// Containers are pointer-events-none so the 3D view stays orbitable; only the
// card and panel capture the pointer.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import type { FleetAsset, FleetTierMap } from '../hooks';
import { assetLabel } from '../lib/assetLabel';
import { isNonLiveTier, pickerLabel, tierSuffix } from '../lib/assetPicker';
import type { AssetTier } from '../lib/assetTier';
import TierCountChips from './TierCountChips';

interface AssetSwitcherProps {
  fleet: FleetAsset[];
  fleetTiers?: FleetTierMap;
  selectedAsset: string;
  setSelectedAsset: (v: string) => void;
  /** Arrivals at the selected edge (things that are not assets yet): a badge under the identity card and a tab. */
  arrivals?: {
    counts: { undeclared: number; expected: number; overdue: number } | null;
    unavailable: boolean;
    view: ReactNode;
  };
}

const DOT_CLASS: Record<AssetTier, string> = {
  ACTIVE:    'bg-emerald-400',
  DEGRADED:  'bg-amber-400',
  STALE:     'bg-slate-500',
  COMM_LOST: 'bg-amber-600',
  LOST:      'bg-rose-500',
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export default function AssetSwitcher({
  fleet, fleetTiers, selectedAsset, setSelectedAsset, arrivals,
}: AssetSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'fleet' | 'arrivals'>('fleet');
  const arrivalsTabRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const counts = arrivals?.counts ?? null;
  const showArrivals = !!counts && counts.undeclared + counts.expected > 0;
  // Counts dropping to zero while the Arrivals tab is open falls back to Fleet.
  const curTab = showArrivals ? tab : 'fleet';

  const selected = fleet.find((a) => a.asset_id === selectedAsset) ?? null;
  const selectedTier = selected ? fleetTiers?.get(selected.asset_id) : undefined;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fleet;
    return fleet.filter((a) =>
      [assetLabel(a), a.asset_id, a.platform_variant ?? '']
        .some((s) => s.toLowerCase().includes(q)),
    );
  }, [fleet, query]);

  // Kept in a ref so the document-level `/` listener never goes stale.
  const openRef = useRef<() => void>(() => {});
  useEffect(() => {
    openRef.current = () => {
      setQuery('');
      const idx = fleet.findIndex((a) => a.asset_id === selectedAsset);
      setActive(idx >= 0 ? idx : 0);
      setTab('fleet');
      setOpen(true);
    };
  }, [fleet, selectedAsset]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const choose = (a: FleetAsset) => {
    setSelectedAsset(a.asset_id);
    close();
  };

  useEffect(() => {
    if (!open) return;
    if (curTab === 'arrivals') arrivalsTabRef.current?.focus();
    else inputRef.current?.focus();
  }, [open, curTab]);

  // `/` opens, from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      openRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const activeIdx = Math.min(active, Math.max(filtered.length - 1, 0));

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (curTab !== 'fleet') {
      // Arrivals tab: list navigation must not hijack the ArrivalForm's inputs.
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) setActive(Math.min(activeIdx + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = filtered[activeIdx];
      if (a) choose(a);
    }
  };

  const nonLive = isNonLiveTier(selectedTier);

  const badgeText = counts
    ? [
        counts.undeclared > 0 ? `${counts.undeclared} undeclared` : '',
        counts.expected > 0 ? `${counts.expected} expected` : '',
      ].filter(Boolean).join(' · ') + (counts.overdue > 0 ? ` · ${counts.overdue} overdue` : '')
    : '';

  return (
    <div ref={rootRef} className="absolute top-3 left-3 z-30 w-[300px] pointer-events-none font-mono">
      <div className="pointer-events-auto flex items-center gap-2 rounded-sm border border-cyan-500/20 bg-slate-950/50 backdrop-blur py-1.5 pl-3 pr-1.5">
        <div className="min-w-0 flex-1" data-testid="asset-identity">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-bold tracking-wider text-cyan-300">
              {selected ? assetLabel(selected) : 'No asset selected'}
            </span>
            {nonLive && (
              <span className="shrink-0 rounded-sm border border-amber-700 bg-amber-900/25 px-1 text-[9px] tracking-widest text-amber-300">
                {tierSuffix(selectedTier)}
              </span>
            )}
          </div>
          {selected?.platform_variant && (
            <div className="truncate text-[10px] tracking-wider text-slate-400">{selected.platform_variant}</div>
          )}
        </div>
        <button
          ref={buttonRef}
          type="button"
          title="Switch asset (/)"
          aria-label="Switch asset"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? close() : openRef.current())}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-slate-600/70 bg-slate-900/60 text-slate-300 transition-colors hover:border-cyan-500 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          <ChevronsUpDown className="h-4 w-4" />
        </button>
      </div>

      {arrivals && counts && showArrivals && (
        <button
          type="button"
          data-testid="arrivals-badge"
          aria-label={`Arrivals: ${badgeText}`}
          onClick={() => { setTab('arrivals'); setOpen(true); }}
          className={`pointer-events-auto mt-1 block rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wider ${
            counts.undeclared > 0 || counts.overdue > 0
              ? 'border-amber-700 bg-amber-900/25 text-amber-300'
              : 'border-slate-600/70 bg-slate-900/60 text-cyan-300'
          }`}
        >
          {badgeText}
        </button>
      )}
      {arrivals?.unavailable && !showArrivals && (
        <div data-testid="arrivals-unavailable" className="mt-1 text-[10px] text-slate-500">
          arrivals unavailable
        </div>
      )}

      {open && (
        <div
          onKeyDown={onPanelKey}
          className={`pointer-events-auto mt-1 rounded-sm border border-cyan-500/20 bg-slate-950/60 p-2 backdrop-blur ${
            curTab === 'arrivals' ? 'w-[380px]' : ''
          }`}
        >
          {showArrivals && counts && (
            <div role="tablist" className="mb-1.5 flex gap-1 text-[11px]">
              {([
                ['fleet', 'Fleet'],
                ['arrivals', `Arrivals ${counts.undeclared + counts.expected}`],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  ref={id === 'arrivals' ? arrivalsTabRef : undefined}
                  type="button"
                  role="tab"
                  aria-selected={curTab === id}
                  onClick={() => setTab(id)}
                  className={`rounded-sm border px-2 py-0.5 tracking-wider ${
                    curTab === id
                      ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                      : 'border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {curTab === 'arrivals' ? (
            arrivals?.view
          ) : (
          <>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            placeholder="Filter assets…"
            aria-label="Filter assets"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered.length ? optId(activeIdx) : undefined}
            className="w-full rounded-sm border border-slate-600/70 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <div className="mt-1.5 flex justify-end">
            <TierCountChips fleet={fleet} tiers={fleetTiers} />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Assets"
            className="mt-1 max-h-[260px] overflow-auto"
          >
            {fleet.length === 0 && (
              <li role="presentation" className="px-2 py-2 text-xs text-slate-500">— no assets in scope —</li>
            )}
            {fleet.length > 0 && filtered.length === 0 && (
              <li role="presentation" className="px-2 py-2 text-xs text-slate-500">no matches</li>
            )}
            {filtered.map((a, i) => {
              const tier = fleetTiers?.get(a.asset_id);
              const dim = isNonLiveTier(tier);
              const isCurrent = a.asset_id === selectedAsset;
              const suffix = tierSuffix(tier);
              return (
                <li
                  key={a.asset_id}
                  id={optId(i)}
                  role="option"
                  aria-selected={isCurrent}
                  aria-label={pickerLabel(a, tier)}
                  onClick={() => choose(a)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${
                    dim ? 'text-slate-400' : 'text-slate-200'
                  } ${isCurrent ? 'bg-cyan-500/15' : i === activeIdx ? 'bg-cyan-500/10' : ''}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tier ?? 'ACTIVE']}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{assetLabel(a)}</span>
                  {a.platform_variant && (
                    <span className="shrink-0 text-[10px] text-slate-500">{a.platform_variant}</span>
                  )}
                  {suffix && (
                    <span className="shrink-0 text-[9px] tracking-widest text-amber-400">— {suffix}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex justify-between border-t border-slate-700/60 px-1 pt-1.5 text-[10px] text-slate-500">
            <span>↑↓ move · enter select</span>
            <span>esc</span>
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
}
