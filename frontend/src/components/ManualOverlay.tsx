// =============================================================================
// ManualOverlay — discreet bottom-left "Ask the manual" over the 3D view
// =============================================================================
// A small glass icon button stacked above the caller's slot (LocalFleetRadar,
// kept visible in a compact glass frame). Clicking opens ManualQuestionPanel in
// a glass panel. The panel stays MOUNTED while closed (just hidden) so an
// in-flight or finished answer is not lost. The container is pointer-events-none
// so the 3D view stays orbitable.
import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import ManualQuestionPanel, { type ManualQuestionPanelProps } from './ManualQuestionPanel';

interface ManualOverlayProps extends ManualQuestionPanelProps {
  /** Content stacked under the button (LocalFleetRadar). */
  bottomLeftSlot?: ReactNode;
}

export default function ManualOverlay({ bottomLeftSlot, ...panelProps }: ManualOverlayProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="absolute bottom-3 left-3 z-20 w-[300px] max-h-[calc(100%-1.5rem)] flex flex-col items-start gap-2 pointer-events-none">
      <div
        role="region"
        aria-label="Ask the manual"
        hidden={!open}
        className="pointer-events-auto w-full min-h-0 overflow-auto rounded-sm border border-cyan-500/20 bg-slate-950/60 backdrop-blur p-3 [&_.panel]:bg-transparent! [&_.panel]:border-0! [&_.panel]:shadow-none! [&_.panel]:rounded-none! [&_.panel]:p-0!"
      >
        <ManualQuestionPanel {...panelProps} />
      </div>
      <button
        type="button"
        title="Ask the manual"
        aria-label="Ask the manual"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border backdrop-blur focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
          open
            ? 'border-cyan-400 bg-cyan-900/40 text-cyan-200'
            : 'border-cyan-500/25 bg-slate-950/55 text-cyan-300 hover:border-cyan-400'
        }`}
      >
        <BookOpen className="h-4 w-4" />
      </button>
      {bottomLeftSlot && (
        <div className="pointer-events-none shrink-0 rounded-sm border border-cyan-500/20 bg-slate-950/50 p-1 backdrop-blur [&_.panel]:bg-transparent! [&_.panel]:rounded-sm!">
          {bottomLeftSlot}
        </div>
      )}
    </div>
  );
}
