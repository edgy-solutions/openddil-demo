// RenderModeMenu — discreet top-right icon button + dropdown for the 3D
// render mode. Sits below HudFrame's top-right DemoMockBanner (top-1).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Layers } from 'lucide-react';
import { RENDER_MODES, RENDER_MODE_LABELS, type RenderMode } from './renderMode';

const SWATCH: Record<RenderMode, string> = {
  matte: 'bg-slate-700 border-slate-500',
  metallic: 'bg-gradient-to-br from-slate-200 to-slate-500 border-slate-300',
  holographic: 'bg-cyan-400/40 border-cyan-300 shadow-[0_0_6px_#22d3ee]',
};

interface RenderModeMenuProps {
  mode: RenderMode;
  onChange: (mode: RenderMode) => void;
  className?: string;
}

export function RenderModeMenu({ mode, onChange, className = 'absolute top-9 right-3 z-30' }: RenderModeMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[RENDER_MODES.indexOf(mode)]?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, mode]);

  const focusItem = (i: number) => {
    const n = RENDER_MODES.length;
    itemRefs.current[((i % n) + n) % n]?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const cur = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(cur + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(cur - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(RENDER_MODES.length - 1);
    }
  };

  const select = (m: RenderMode) => {
    onChange(m);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div ref={rootRef} className={className}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Render mode: ${RENDER_MODE_LABELS[mode]}`}
        title="Render mode"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="w-7 h-7 flex items-center justify-center rounded-sm border border-slate-600/70 bg-slate-900/60 backdrop-blur text-cyan-300 hover:border-cyan-500 hover:text-cyan-200 transition-colors"
      >
        <Layers className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Render mode"
          onKeyDown={onMenuKey}
          className="absolute right-0 mt-1 min-w-[10rem] rounded-sm border border-slate-600/70 bg-slate-900/80 backdrop-blur p-1 font-mono text-[0.7rem] tracking-widest"
        >
          {RENDER_MODES.map((m, i) => (
            <button
              key={m}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              tabIndex={-1}
              onClick={() => select(m)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-slate-200 hover:bg-slate-700/60 focus:bg-slate-700/60 focus:outline-none"
            >
              <span className={`inline-block w-3 h-3 rounded-sm border ${SWATCH[m]}`} />
              <span className="flex-1">{RENDER_MODE_LABELS[m]}</span>
              {m === mode && <Check className="w-3.5 h-3.5 text-cyan-300" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
