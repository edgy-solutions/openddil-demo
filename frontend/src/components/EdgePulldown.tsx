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
// AFFIRMATIVE SCOPE DISPLAY:
//   The control is a ScopeControl (components/ScopeControl.tsx), which
//   decides its own shape from available.length alone:
//   - More than one edge observed: a <select>, user picks which edge.
//   - Exactly one edge observed: a plain label naming that edge — not a
//     disabled <select>, no "(only edge observed)" hint. A label reads as
//     "this is where you are"; a disabled control reads as "something is
//     broken here."
//   - Cold start (no edges observed yet): ScopeControl's emptyText label.
import { ChevronRight } from 'lucide-react';
import ScopeControl from './ScopeControl';

interface EdgePulldownProps {
  available: string[];
  selected: string | null;
  onSelect: (edgeId: string) => void;
}

export default function EdgePulldown({ available, selected, onSelect }: EdgePulldownProps) {
  return (
    <div className="flex flex-col pr-4 border-r border-slate-700">
      <div className="flex items-center gap-2">
        <ScopeControl
          variant="header"
          label="EDGE"
          available={available}
          selected={selected}
          onSelect={onSelect}
          emptyText="no edges observed yet"
        />
        {/* Chevron separator into the asset picker — sets up the two-
            level "EDGE › ASSET" framing. Muted slate to match the
            overall chrome palette (was cyan, dialed back per user
            feedback that the cyan was too bright). */}
        <ChevronRight className="w-5 h-5 text-slate-600 shrink-0" />
      </div>
    </div>
  );
}
