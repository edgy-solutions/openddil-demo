// =============================================================================
// Nation colouring — ADR-0029 releasability, made legible
// =============================================================================
// PRESENTATION ONLY. Colour is how an operator SEES which nation an asset
// belongs to; it is not, and must never become, a filter. By the time a row
// reaches the browser the gateway has already decided the subject may see it
// (ADR-0029 §1), and a second filter here would be a second authorization
// decision that nobody reviewed.
//
// WHY UNLABELLED IS ITS OWN VISUAL STATE, AND NOT A DEFAULT COLOUR
// An asset with no `originator_nation` is not "probably ours". Under the
// target deny-unlabeled policy it is releasable to nobody, and the §7
// completeness gate exists precisely to stop such rows reaching a screen at
// all. If one does, the operator must be able to SEE that it is unlabelled
// rather than infer a nation from a colour somebody picked as a fallback.
// A mislabelled asset on a map is worse than an obviously unlabelled one.
//
// THE PALETTE IS NOT SEMANTIC. These are identity colours, deliberately
// chosen away from the severity palette (emerald / amber / rose) that the
// rest of this UI uses for health and tiering. An operator must never have
// to wonder whether a red asset is Bordurian or broken.

export interface NationStyle {
  /** Short code shown in chips and legends. */
  code: string;
  label: string;
  /** Tailwind classes, kept together so a caller cannot pair one nation's
   *  text colour with another's border. */
  chip: string;
  dot: string;
  /** Raw hex, for canvas / 3D consumers that cannot use classes. */
  hex: string;
}

// Fictional nations. Atlantia and Borduria are invented; a deployment with
// real coalition partners supplies its own table and never commits it here.
const NATIONS: Record<string, NationStyle> = {
  ATL: {
    code: 'ATL',
    label: 'Atlantia',
    chip: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    dot: 'bg-sky-400',
    hex: '#38bdf8',
  },
  BDR: {
    code: 'BDR',
    label: 'Borduria',
    chip: 'bg-violet-500/15 text-violet-300 border-violet-500/40',
    dot: 'bg-violet-400',
    hex: '#a78bfa',
  },
};

// The unlabelled state. Hatched grey, and it SAYS "unlabelled" rather than
// showing an empty chip — an empty chip reads as "no data yet", which is a
// different claim.
export const UNLABELLED: NationStyle = {
  code: '—',
  label: 'unlabelled',
  chip: 'bg-slate-600/20 text-slate-400 border-slate-500/40 border-dashed',
  dot: 'bg-slate-500',
  hex: '#64748b',
};

// A nation the palette does not know. Distinct from unlabelled, because the
// two mean opposite things: this row IS labelled, by a nation this UI has no
// colour for. Showing it as unlabelled would be a lie about the data.
export function unknownNation(code: string): NationStyle {
  return {
    code,
    label: `${code} (no palette entry)`,
    chip: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
    dot: 'bg-amber-400',
    hex: '#fbbf24',
  };
}

export function nationStyle(code: string | null | undefined): NationStyle {
  if (!code) return UNLABELLED;
  return NATIONS[code] ?? unknownNation(code);
}

/** Nations present in a fleet, in palette order then alphabetically, so a
 *  legend does not reshuffle as rows arrive. */
export function nationsInFleet(
  assets: { originator_nation: string | null }[],
): NationStyle[] {
  const seen = new Set<string>();
  let anyUnlabelled = false;
  for (const a of assets) {
    if (a.originator_nation) seen.add(a.originator_nation);
    else anyUnlabelled = true;
  }
  const known = Object.keys(NATIONS).filter((c) => seen.has(c));
  const extra = [...seen].filter((c) => !(c in NATIONS)).sort();
  const out = [...known, ...extra].map(nationStyle);
  // The unlabelled entry appears in the legend ONLY when such a row is
  // actually on screen. A permanent "unlabelled" key would train the eye to
  // ignore it, which is the opposite of why it exists.
  if (anyUnlabelled) out.push(UNLABELLED);
  return out;
}

/** True when this asset reaches the viewer through the SECOND clause of the
 *  ADR-0029 §4 filter — released to them rather than originated by them.
 *
 *  Worth showing, because it is the difference between "my fleet" and "an
 *  ally's asset I have been given sight of", and an operator acting on the
 *  second without knowing it is the coalition mistake this whole mechanism
 *  is about. */
export function isSharedWith(
  asset: { originator_nation: string | null; releasable_to: string[] },
  viewerNations: string[],
): boolean {
  if (!asset.originator_nation) return false;
  if (viewerNations.includes(asset.originator_nation)) return false;
  return asset.releasable_to.some((n) => viewerNations.includes(n));
}
