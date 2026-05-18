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
// UX VISUAL TREATMENT:
//   Matches the ASSET picker's chrome (slate-800 bg, slate-700 border,
//   slate-200 text, slate-400 label, single border-width). The §C.2
//   recipe originally specified the maintainer pulldown as "visually
//   prominent" with cyan-tinted prominent border + bold cyan EDGE label
//   (the "demo narrative payoff" framing), but user feedback post-§C.3
//   was "too bright" — dialed back to match the ASSET picker for visual
//   coherence. The §C.3 transit animation does the demo-narrative work;
//   the pulldown chrome can stay quiet.
//
//   (Follow-up #15's regional-vs-maintainer asymmetry still applies in
//   substance: only the maintainer view has the FOB-transport animation
//   on scope change, only the maintainer pulldown's scope-change matters
//   for the demo narrative. The asymmetry shows up in WHAT happens on
//   change, not in HOW the control looks.)
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
    <div className="flex flex-col pr-4 border-r border-slate-700">
      <label className="text-[10px] text-slate-400 tracking-wider mb-1">
        EDGE
      </label>
      <div className="flex items-center gap-2">
        <div className="relative">
          <select
            value={displayValue}
            onChange={(e) => onSelect(e.target.value)}
            disabled={isColdStart || isSingleEdge}
            className={`appearance-none w-44 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500
              ${isColdStart || isSingleEdge ? 'text-slate-400 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {isColdStart && (
              <option value="">— no edges observed yet —</option>
            )}
            {!isColdStart && available.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
            <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
            </svg>
          </div>
        </div>
        {/* Chevron separator into the asset picker — sets up the two-
            level "EDGE › ASSET" framing. Muted slate to match the
            overall chrome palette (was cyan, dialed back per user
            feedback that the cyan was too bright). */}
        <ChevronRight className="w-5 h-5 text-slate-600 shrink-0" />
        {isSingleEdge && (
          <span className="text-[10px] text-slate-500 italic">
            (only edge observed)
          </span>
        )}
      </div>
    </div>
  );
}
