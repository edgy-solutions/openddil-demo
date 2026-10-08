// Pure helpers for the regional tier's scope selection.

/** Gates the ?region= deep-link param against URL injection. Accepts any
 *  kebab-case identifier so deployments that name regions geographically
 *  work without code changes. */
export const REGION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/** The ?region= param, or null when it is malformed or names a scope the
 *  FOB-declared regions do not include. With no FOB regions declared there
 *  is nothing to check it against, so a well-formed param is accepted. */
export function acceptRegionParam(
  param: string | null,
  fobRegions: string[],
): string | null {
  if (!param || !REGION_ID_PATTERN.test(param)) return null;
  if (fobRegions.length > 0 && !fobRegions.includes(param)) return null;
  return param;
}

/** A replacement for a selection that matches nothing known, or null to
 *  leave it alone. Heals onto the first observed region (sorted); never
 *  acts while nothing has been observed yet. */
export function healRegion(
  selected: string | null,
  fobRegions: string[],
  observedRegions: string[],
): string | null {
  if (observedRegions.length === 0) return null;
  if (selected && (fobRegions.includes(selected) || observedRegions.includes(selected))) {
    return null;
  }
  return [...observedRegions].sort()[0];
}
