// =============================================================================
// NationLegend — which colour is which nation, and what a dashed key means
// =============================================================================
// A colour that nobody can decode is decoration. This is small on purpose: it
// belongs beside the fleet, not in a settings panel.
//
// THE LEGEND IS DERIVED FROM WHAT IS ON SCREEN, not from the palette. An
// operator entitled to one nation sees one key — showing them a key for a
// nation whose assets they cannot see would tell them that nation exists in
// this deployment, which is a small leak of exactly the kind this mechanism
// exists to prevent.
import { nationsInFleet, isSharedWith } from '../../lib/nationColor';

interface Props {
  assets: { originator_nation: string | null; releasable_to: string[] }[];
  /** Nations the VIEWER holds, used only to decide whether the "released to
   *  you" key is worth showing. Presentation, not filtering. */
  viewerNations?: string[];
  className?: string;
}

export default function NationLegend({ assets, viewerNations = [], className = '' }: Props) {
  const nations = nationsInFleet(assets);
  if (nations.length === 0) return null;

  const anyShared = viewerNations.length > 0
    && assets.some((a) => isSharedWith(a, viewerNations));

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]
                     text-slate-400 ${className}`}>
      {nations.map((n) => (
        <span key={n.code} className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${n.dot}`} />
          <span className="uppercase tracking-wide">{n.code}</span>
          <span className="text-slate-500">{n.label}</span>
        </span>
      ))}

      {/* Shown only when such an asset is actually on screen. A permanent key
          would train the eye past it, and this is the one an operator most
          needs to notice: an ally's asset they have been given sight of is
          not their asset to act on. */}
      {anyShared && (
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full ring-1 ring-slate-300 ring-offset-1
                           ring-offset-slate-900" />
          <span className="text-slate-500">released to you by another nation</span>
        </span>
      )}
    </div>
  );
}
