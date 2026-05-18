// =============================================================================
// EdgePulldown — Phase 6c.2 maintainer-view scope mechanism
// =============================================================================
// Per-edge scope control for the maintainer view. Renders inside Header.tsx
// to the LEFT of the asset picker, forming a two-level chrome:
//
//   EDGE: [edge-02] › ASSET: [dis:1:1:2500]
//
// Reads "you are AT edge-02 looking at one of its assets."
//
// UX ASYMMETRY vs the §C.1 RegionPulldown (deliberate — see tracked
// follow-up #15 + ADR-0023):
//   - Regional pulldown: visually unobtrusive (dev infrastructure; no
//     production analog because auth-context binds region in prod).
//   - Maintainer pulldown (THIS one): visually prominent — the demo
//     narrative payoff per ADR-0023 ("FOB transport" metaphor). Larger
//     label, higher contrast border, foreground emphasis. §C.3's
//     animated transition will play off whatever weight this pulldown
//     establishes; this is the canvas §C.3 paints on.
//
// AFFIRMATIVE SCOPE DISPLAY (Q5.c.2 decision):
//   - Multi-edge deployment (3 edges): pulldown is enabled; user
//     selects which edge to scope to.
//   - Single-edge deployment: pulldown is DISABLED but still shows the
//     one observed edge's name with hint "(only edge observed)". User
//     sees what scope they're at; they just can't switch. Affirmative
//     display in degenerate cases beats the empty / "no selection
//     possible" pattern.
//   - Cold start (no edges observed yet): pulldown shows "no edges
//     observed yet" placeholder, disabled.
import { ChevronRight } from 'lucide-react';

interface EdgePulldownProps {
  available: string[];
  selected: string | null;
  onSelect: (edgeId: string) => void;
}

export default function EdgePulldown({ available, selected, onSelect }: EdgePulldownProps) {
  const isColdStart = available.length === 0;
  const isSingleEdge = available.length === 1;
  // Affirmative-display for the single-edge case: show the observed
  // edge's name as the (disabled) selected value, not "—".
  const singleEdgeId = isSingleEdge ? available[0] : null;
  const displayValue = isColdStart
    ? ''
    : (selected ?? singleEdgeId ?? '');

  return (
    <div className="flex flex-col pr-4 border-r-2 border-cyan-900/40">
      <label className="text-[10px] text-cyan-300 tracking-widest font-bold mb-1">
        EDGE
      </label>
      <div className="flex items-center gap-2">
        <div className="relative">
          <select
            value={displayValue}
            onChange={(e) => onSelect(e.target.value)}
            disabled={isColdStart || isSingleEdge}
            className={`appearance-none w-44 border-2 text-sm rounded px-3 py-1.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-cyan-500
              ${isColdStart || isSingleEdge
                ? 'bg-slate-900 border-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-cyan-950/30 border-cyan-700/60 text-cyan-100 focus:border-cyan-400'}`}
          >
            {isColdStart && (
              <option value="">— no edges observed yet —</option>
            )}
            {!isColdStart && available.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-cyan-400">
            <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
            </svg>
          </div>
        </div>
        {/* Chevron separator into the asset picker — sets up the two-
            level "EDGE: › ASSET:" framing the §C.3 animation will play
            off of. */}
        <ChevronRight className="w-5 h-5 text-cyan-700 shrink-0" />
        {isSingleEdge && (
          <span className="text-[10px] text-slate-500 italic">
            (only edge observed)
          </span>
        )}
      </div>
    </div>
  );
}
