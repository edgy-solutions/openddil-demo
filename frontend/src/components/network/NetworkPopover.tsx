// =============================================================================
// NetworkPopover — the header's network pill and the panel it opens
// =============================================================================
// The persistent header carries only the pill: a status dot and the link
// summary. Everything else about the network (path diagram, observed
// link label, buffer, link rows, shaping) lives in the popover.
//
// The dot's tone is computed by the caller from OBSERVED state only (see
// network/tone.ts); this component just draws it.
//
// Behaviour: the pill toggles the popover; an outside mousedown closes it;
// Escape first collapses an expanded link row and only then closes the
// popover, returning focus to the pill.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { ExpansionContext } from './expansion';
import type { Tone } from './tone';

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_8px_#34d399]',
  warn: 'bg-amber-400 shadow-[0_0_8px_#f59e0b]',
  bad: 'bg-rose-500 shadow-[0_0_8px_#f43f5e]',
  neutral: 'bg-slate-500',
};

export interface NetworkPopoverProps {
  /** Dot tone, from observed state. */
  tone: Tone;
  /** What the pill shows beside the dot (see LinkSummary). */
  summary: ReactNode;
  children: ReactNode;
}

export default function NetworkPopover({ tone, summary, children }: NetworkPopoverProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setExpanded(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (expanded !== null) {
        setExpanded(null);
      } else {
        close();
        pillRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, expanded, close]);

  const toggleExpanded = useCallback(
    (key: string) => setExpanded((cur) => (cur === key ? null : key)),
    [],
  );

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        ref={pillRef}
        type="button"
        data-testid="network-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex items-center h-7 gap-2.5 rounded-full border py-0.5 pl-3 pr-[3px] transition-colors ${
          open
            ? 'border-cyan-700 bg-cyan-950/40'
            : 'border-slate-700 bg-transparent hover:border-cyan-700 hover:bg-cyan-950/30'
        }`}
      >
        <span data-testid="network-pill-dot" data-tone={tone} className={`h-[7px] w-[7px] rounded-full ${DOT[tone]}`} />
        {summary}
        <span className={`grid h-5 w-5 place-items-center rounded-full bg-slate-800 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
          <ChevronDown className="h-3 w-3 text-slate-300" aria-hidden="true" />
        </span>
      </button>

      {open && (
        <div
          id={popId}
          role="dialog"
          aria-label="Network"
          style={{ width: 'min(480px, calc(100vw - 24px))' }}
          className="absolute right-0 top-full z-50 mt-2 max-h-[min(80vh,calc(100vh-120px))] overflow-y-auto rounded-sm border border-cyan-400/20 bg-[rgba(8,14,26,0.92)] shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between px-3.5 pt-3">
            <span className="text-[9px] tracking-[0.16em] text-slate-500">NETWORK</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => { close(); pillRef.current?.focus(); }}
              className="grid h-6 w-6 place-items-center rounded-sm text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
          <ExpansionContext.Provider value={{ expanded, toggle: toggleExpanded }}>
            {children}
          </ExpansionContext.Provider>
        </div>
      )}
    </div>
  );
}
