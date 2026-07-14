// =============================================================================
// assetGeometry — per-platform geometry tables for AssetVisual + LaunchPad
// =============================================================================
// Extracted from AssetVisual.tsx so the load-bearing numbers are unit-
// testable. Each table is a per-variant tuning that drives a visible
// invariant in the rendered scene; the comments at each declaration
// explain the visual contract. Tests in __tests__/assetGeometry.test.ts
// pin the invariants so a future "simplification" of any constant
// doesn't silently regress the demo visuals.
//
// Five tables:
//   * GROUND_OFFSET           — lifts a schematic so its lowest geometry
//                               sits at world Y=0 (ground plane).
//   * ASSET_HEIGHT            — top-of-visible extent per variant; sizes
//                               the selected-asset spotlight cylinder.
//   * ASSET_FOOTPRINT_RADIUS  — per-variant lateral envelope; sizes the
//                               severity ring + outer halo + cylinder
//                               diameter for assets bigger than the
//                               default footprint (launchers).
//   * LAUNCH_PADS             — pad height in native units; tuned so
//                               the hinge bottom of a launcher sits ON
//                               the pad top (no float).
//   * PAD_RADIUS_NATIVE       — pad radius in native units; sized to
//                               the schematic's base element (hinge),
//                               NOT the overall footprint, so the
//                               pod sweeps freely past pad edges.
//
// Invariants the tests pin:
//   1. Every variant in ASSET_HEIGHT also has a GROUND_OFFSET entry.
//   2. Launcher LAUNCH_PADS height equals GROUND_OFFSET - 2.5 (hinge
//      native Y = -2.5; the pad must be exactly that tall so the
//      hinge bottom lands on pad top after the lift).
//   3. Launcher ASSET_HEIGHT covers the peak-tilt pod corner (= ~8
//      native, was 6.5 and got bumped in dcfc97c after operator
//      flagged the cylinder being too short).
//   4. PAD_RADIUS_NATIVE < ASSET_FOOTPRINT_RADIUS for launchers
//      (pad sized to hinge, ring sized to pod — distinct).

export const DEFAULT_GROUND_OFFSET = 1.6;
export const DEFAULT_ASSET_HEIGHT = 3.2;

// Per-variant visual-scale multiplier applied on top of the AssetVisual
// `scale` prop. Use 1.0 (default) for variants that look correctly
// proportioned at the scene-wide scale; smaller values shrink an
// over-large schematic; larger values bump up an under-sized one.
//
// The launcher entries shrink the artillery silhouette because its
// native footprint (pod 4.5x3.5x7, hinge 4x1x4) renders ~3x the on-
// screen presence of a sensor (dish ~2.4x2.4) at the same scale prop,
// dominating co-located scenes. 0.6 brings the launcher's visible
// extent in line with sensor footprints without breaking the native-
// unit invariants (LAUNCH_PADS, GROUND_OFFSET, etc. all multiply
// through the same effective scale so the pad / ring / spotlight
// stay coherent with the shrunken pod).
export const DEFAULT_VARIANT_SCALE = 1.0;
export const ASSET_VARIANT_SCALE: Readonly<Record<string, number>> = {
  'CUAS_Interceptor':    0.6,
  'VSHORAD_Interceptor': 0.6,
  'SHORAD_Interceptor':  0.6,
  'MRAD_Interceptor':    0.6,
  'MISSILE_LAUNCHER':    0.6,
};

export const GROUND_OFFSET: Readonly<Record<string, number>> = {
  // ORBAT sensors — all use SensorRadarSchematic; base at Y=-1.1
  'CUAS_Sensor':    1.1,
  'VSHORAD_Sensor': 1.1,
  'SHORAD_Sensor':  1.1,
  'MRAD_Sensor':    1.1,
  // ORBAT interceptors + launcher — Artillery schematic. 4.5 lifts the
  // hinge bottom (native Y=-2.5) to (4.5-2.5)*scale = 2.0*scale world,
  // which the LAUNCH_PADS table is sized to meet.
  'CUAS_Interceptor':    4.5,
  'VSHORAD_Interceptor': 4.5,
  'SHORAD_Interceptor':  4.5,
  'MRAD_Interceptor':    4.5,
  'MISSILE_LAUNCHER':    4.5,
  // ORBAT facilities — pad bottom around Y=-1.0
  'AIR_DEFENSE_SITE':              1.0,
  'HEADQUARTER_COMPLEX':           1.0,
  'INSTALLATION_FACILITY_CIVILIAN': 1.0,
  // Legacy DIS variants
  'M1A2-SEPv3': 0.8,
  'M1A2-SEPv2': 0.8,
  'AH-64E':     0.5,
};

export const ASSET_HEIGHT: Readonly<Record<string, number>> = {
  'CUAS_Sensor':    3.4,
  'VSHORAD_Sensor': 3.6,
  'SHORAD_Sensor':  3.9,
  'MRAD_Sensor':    4.2,
  // Launchers: 8.0 native covers the pod's peak-tilt back-top corner
  // (asset Y ~ +4.1) plus the pad height (2.0). Bumped from 6.5 in
  // dcfc97c after operator feedback that the cylinder was clipping
  // the launcher at peak tilt.
  'CUAS_Interceptor':    8.0,
  'VSHORAD_Interceptor': 8.0,
  'SHORAD_Interceptor':  8.0,
  'MRAD_Interceptor':    8.0,
  'MISSILE_LAUNCHER':    8.0,
  'AIR_DEFENSE_SITE':              3.5,
  'HEADQUARTER_COMPLEX':           4.5,
  'INSTALLATION_FACILITY_CIVILIAN': 3.5,
  'M1A2-SEPv3': 3.0,
  'M1A2-SEPv2': 3.0,
  'AH-64E':     2.5,
};

export const ASSET_FOOTPRINT_RADIUS: Readonly<Record<string, number>> = {
  // Launchers — sized so the RENDERED ring (footprint * effectiveScale,
  // where effectiveScale = SCENE_ASSET_SCALE * variantScale = 0.35 *
  // 0.6 = 0.21) is roughly 0.7 world units. Adjacent launchers at a
  // typical FOB cluster (~1.8-2.6 world units apart in raw projection)
  // then clear each other's rings with margin. Previous 6.0 gave ring
  // = 1.26 world, which visibly overlapped adjacent-bucket assets in
  // dense FOB clusters (operator report 2026-07-14).
  'CUAS_Interceptor':    3.3,
  'VSHORAD_Interceptor': 3.3,
  'SHORAD_Interceptor':  3.3,
  'MRAD_Interceptor':    3.3,
  'MISSILE_LAUNCHER':    3.3,
};

export const LAUNCH_PADS: Readonly<Record<string, number>> = {
  'CUAS_Interceptor':    2.0,
  'VSHORAD_Interceptor': 2.0,
  'SHORAD_Interceptor':  2.0,
  'MRAD_Interceptor':    2.0,
  'MISSILE_LAUNCHER':    2.0,
};

export const PAD_RADIUS_NATIVE: Readonly<Record<string, number>> = {
  // Sized to ArtillerySchematic's HINGE base (4×4 native square),
  // NOT the pod (4.5×7). Pod sweeps freely past pad edges during
  // peak tilt; the trade-off is the pod tip momentarily appearing
  // below pad-top in open air (operator-accepted, see commit
  // 0c3c9a3).
  'CUAS_Interceptor':    2.0,
  'VSHORAD_Interceptor': 2.0,
  'SHORAD_Interceptor':  2.0,
  'MRAD_Interceptor':    2.0,
  'MISSILE_LAUNCHER':    2.0,
};

// ---------------------------------------------------------------------------
// Lookup helpers — all default-aware, all return numbers ready to
// multiply by `scale` at the render site.
// ---------------------------------------------------------------------------

export function resolveGroundOffset(platformVariant: string | null | undefined): number {
  if (!platformVariant) return DEFAULT_GROUND_OFFSET;
  return GROUND_OFFSET[platformVariant] ?? DEFAULT_GROUND_OFFSET;
}

export function resolveAssetHeight(platformVariant: string | null | undefined): number {
  if (!platformVariant) return DEFAULT_ASSET_HEIGHT;
  return ASSET_HEIGHT[platformVariant] ?? DEFAULT_ASSET_HEIGHT;
}

/** Per-variant visual-scale multiplier. Apply this on the caller's
 *  base scale to derive an effective scale that shrinks/grows just
 *  the over- or under-sized variants. Defaults to 1.0 so variants
 *  with no entry render at their existing on-screen size. */
export function resolveVariantScale(platformVariant: string | null | undefined): number {
  if (!platformVariant) return DEFAULT_VARIANT_SCALE;
  return ASSET_VARIANT_SCALE[platformVariant] ?? DEFAULT_VARIANT_SCALE;
}

/** Footprint radius — undefined when the variant uses the default
 *  3*scale ring sizing rather than a per-variant override. Returning
 *  undefined lets the caller distinguish "no override" from "override
 *  to default value" so the existing Math.max(1, 3*scale) branch
 *  stays intact. */
export function resolveFootprintRadius(platformVariant: string | null | undefined): number | undefined {
  if (!platformVariant) return undefined;
  return ASSET_FOOTPRINT_RADIUS[platformVariant];
}

/** Launch-pad height in native units, or undefined if this variant
 *  doesn't render a pad. */
export function resolvePadHeight(platformVariant: string | null | undefined): number | undefined {
  if (!platformVariant) return undefined;
  return LAUNCH_PADS[platformVariant];
}

/** Launch-pad radius in native units, or undefined if this variant
 *  doesn't render a pad. */
export function resolvePadRadius(platformVariant: string | null | undefined): number | undefined {
  if (!platformVariant) return undefined;
  return PAD_RADIUS_NATIVE[platformVariant];
}

// ---------------------------------------------------------------------------
// Composite calculators — final world-unit values the renderer uses.
// ---------------------------------------------------------------------------

/** Effective severity-ring radius. Per-variant footprint override wins;
 *  otherwise a tight default sized just outside the schematic silhouette.
 *
 *  2026-07-14: dropped from Math.max(1, 3*scale) to Math.max(0.4,
 *  1.7*scale). At SCENE_ASSET_SCALE=0.35 that gives sensor rings ~0.6
 *  world units (was 1.05). Rings still clear the sensor dish
 *  silhouette (~0.42 world half-width) with margin, and adjacent
 *  assets at typical FOB clustering distances no longer visually
 *  collide (dense-FOB operator report). Small floor (0.4) preserves
 *  visibility if a caller passes an unusually small scale. */
export function resolveRingRadius(
  platformVariant: string | null | undefined,
  scale: number,
): number {
  const footprint = resolveFootprintRadius(platformVariant);
  if (footprint !== undefined) {
    return Math.max(0.4, footprint * scale);
  }
  return Math.max(0.4, 1.7 * scale);
}

/** Pad-mesh radius in world units. Uses the per-variant override when
 *  the variant has a pad; otherwise Math.max(0.9, 2.5*scale) as a
 *  generic floor. Caller still gates on resolvePadHeight() to decide
 *  whether to render a pad at all. */
export function resolvePadWorldRadius(
  platformVariant: string | null | undefined,
  scale: number,
): number {
  const nativeRadius = resolvePadRadius(platformVariant);
  if (nativeRadius !== undefined) {
    return nativeRadius * scale;
  }
  return Math.max(0.9, 2.5 * scale);
}
