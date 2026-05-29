// =============================================================================
// coLocationLayout — pure geometry for the Regional co-location stagger
// =============================================================================
// Extracted from RegionalSustainmentPosture.buildRenderables so the
// layout math is unit-testable. The formulas below decide where each
// asset renders when multiple assets share a position (FOB centroid):
// facility-class entities sit at center, leaf entities (sensors,
// interceptors, launchers) ring around them.
//
// Three load-bearing constants here. Tune them visually; pin them
// numerically. Visual-regression risk: if anyone refactors the
// stagger to "just use a tighter spacing" without re-checking that
// adjacent launcher schematics still clear each other, the demo
// renders overlapping silhouettes again — exactly the bug we landed
// the stagger for in commit 927a738.
//
// Constants:
//   * COLOC_MIN_SPACING (2.5) — minimum world-unit gap between
//     adjacent ring slots. ArtillerySchematic pod ~2 wide at scale
//     0.35; 2.5 keeps adjacent launchers clear with a slight buffer.
//   * COLOC_BUCKET (0.5) — bucket-key grain for "same point"
//     detection. Well below COLOC_MIN_SPACING (no spurious bucket
//     merges from staggered positions) and above lat/lon projection
//     float noise.
//   * FACILITY_RING_MIN_RADIUS (4.0) — minimum ring radius when a
//     facility sits at center. MilitaryFacilitySchematic 5×6 native
//     pad has half-diagonal ~1.37 world at scale 0.35; the ring
//     must clear that plus the ring-asset's own footprint plus
//     a small buffer.
//
// Ring radius formula:
//
//   R = max(min_radius, N * COLOC_MIN_SPACING / 2π)
//
//   where N = number of ring assets. The second term keeps adjacent
//   slots at >= COLOC_MIN_SPACING arc-length apart, derived from
//   arc = R * angle, angle = 2π/N. The max() takes whichever is
//   bigger — the geometric clearance OR the facility-floor radius.

export const COLOC_MIN_SPACING = 2.5;
export const COLOC_BUCKET = 0.5;
export const FACILITY_RING_MIN_RADIUS = 4.0;

/** Platform-variant names that get placed at the bucket centroid
 *  rather than in the ring. Mirrors the FACILITY_VARIANTS set in
 *  RegionalSustainmentPosture. */
export const FACILITY_VARIANTS: ReadonlySet<string> = new Set([
  'AIR_DEFENSE_SITE',
  'HEADQUARTER_COMPLEX',
  'INSTALLATION_FACILITY_CIVILIAN',
]);

/** Bucket-key generator. Rounds (x, z) to the COLOC_BUCKET grid so
 *  positions within `COLOC_BUCKET` units of each other land in the
 *  same bucket. Order: x first, then z, separated by '|'. */
export function colocationBucketKey(x: number, z: number): string {
  return `${Math.round(x / COLOC_BUCKET)}|${Math.round(z / COLOC_BUCKET)}`;
}

/** Ring radius for a co-location bucket. `n` is the count of assets
 *  that need ring slots (i.e. NOT counting any facility-class entities
 *  that sit at center). `hasFacility` selects the floor radius:
 *  FACILITY_RING_MIN_RADIUS when a facility sits at center,
 *  COLOC_MIN_SPACING otherwise (a same-class bucket of leaves only
 *  needs the spacing-from-each-other floor, not the facility-clearance
 *  floor). */
export function colocationRingRadius(
  n: number,
  hasFacility: boolean,
): number {
  const floor = hasFacility ? FACILITY_RING_MIN_RADIUS : COLOC_MIN_SPACING;
  const geometric = (n * COLOC_MIN_SPACING) / (2 * Math.PI);
  return Math.max(floor, geometric);
}

/** Ring-slot position for the i-th of n ring assets around centroid
 *  (cx, cz) at the given radius. Slots are equally spaced around
 *  2π — i=0 points east (cos(0) = 1, sin(0) = 0). Order is consistent
 *  with the stable sort in buildRenderables (platform_variant +
 *  asset_id), so adjacent slots stay adjacent across re-renders. */
export function colocationRingSlot(
  cx: number,
  cz: number,
  radius: number,
  i: number,
  n: number,
): { x: number; z: number } {
  const angle = (i / n) * Math.PI * 2;
  return {
    x: cx + Math.cos(angle) * radius,
    z: cz + Math.sin(angle) * radius,
  };
}

/** Whether a platform_variant is treated as a facility (placed at
 *  centroid) vs a leaf (placed in ring). Defensive on null/undefined:
 *  unaliased assets (UNKNOWN, null platform_variant) are leaves. */
export function isFacilityVariant(platformVariant: string | null | undefined): boolean {
  if (!platformVariant) return false;
  return FACILITY_VARIANTS.has(platformVariant);
}
