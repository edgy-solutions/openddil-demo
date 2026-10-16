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

import type { CSSProperties } from 'react';

export interface NationStyle {
  /** Short code shown in chips and legends. */
  code: string;
  label: string;
  /** Tailwind classes for the FIXED states (unlabelled, unknown), kept
   *  together so a caller cannot pair one state's text colour with another's
   *  border. For a registry nation these are only the shape classes; its
   *  colours arrive as `chipStyle`, because Tailwind cannot build a class
   *  from a hex it only learns at runtime. */
  chip: string;
  dot: string;
  /** Inline colours for a registry nation; absent for the fixed states. */
  chipStyle?: CSSProperties;
  dotStyle?: CSSProperties;
  /** Raw hex, for canvas / 3D consumers that cannot use classes. */
  hex: string;
}

/** One entry of the deployment's nations registry, as the gateway serves it
 *  in /auth/me (`nation_registry`, in the order the ontology file lists
 *  them). `color` is null when the file gave none or an invalid one. */
export interface NationRegistryEntry {
  code: string;
  name: string;
  color: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Defensive read of the wire value: anything malformed is dropped rather
 *  than trusted, since it ends up in a style attribute. */
export function parseNationRegistry(raw: unknown): NationRegistryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NationRegistryEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e.code !== 'string' || !e.code) continue;
    out.push({
      code: e.code,
      name: typeof e.name === 'string' && e.name ? e.name : e.code,
      color: typeof e.color === 'string' && HEX.test(e.color) ? e.color : null,
    });
  }
  return out;
}

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

// The palette is the deployment's, not this file's: a registry entry with a
// colour becomes a style, and nothing else does. Fictional nations ship in
// the demo ontology; a deployment with real partners supplies its own.
function registryStyle(e: NationRegistryEntry): NationStyle | null {
  if (!e.color) return null;
  return {
    code: e.code,
    label: e.name,
    chip: 'border',
    dot: '',
    chipStyle: {
      backgroundColor: e.color + '26',
      color: e.color,
      borderColor: e.color + '66',
    },
    dotStyle: { backgroundColor: e.color },
    hex: e.color,
  };
}

export function nationStyle(
  code: string | null | undefined,
  registry: NationRegistryEntry[] = [],
): NationStyle {
  if (!code) return UNLABELLED;
  const e = registry.find((r) => r.code === code);
  return (e && registryStyle(e)) ?? unknownNation(code);
}

/** Nations present in a fleet, in registry order then alphabetically, so a
 *  legend does not reshuffle as rows arrive. */
export function nationsInFleet(
  assets: { originator_nation: string | null }[],
  registry: NationRegistryEntry[] = [],
): NationStyle[] {
  const seen = new Set<string>();
  let anyUnlabelled = false;
  for (const a of assets) {
    if (a.originator_nation) seen.add(a.originator_nation);
    else anyUnlabelled = true;
  }
  const known = registry.map((r) => r.code).filter((c) => seen.has(c));
  const extra = [...seen].filter((c) => !known.includes(c)).sort();
  const out = [...known, ...extra].map((c) => nationStyle(c, registry));
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
