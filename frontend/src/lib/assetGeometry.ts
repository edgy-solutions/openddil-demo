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
  // Launchers only — 6.0 native gives ring=2.1 world at scale 0.35,
  // outer halo (1.5x) = 3.15 world, larger than the pod's top-down
  // diagonal (~2.92 world). Other variants use the
  // Math.max(1, 3*scale) default in resolveRingRadius().
  'CUAS_Interceptor':    6.0,
  'VSHORAD_Interceptor': 6.0,
  'SHORAD_Interceptor':  6.0,
  'MRAD_Interceptor':    6.0,
  'MISSILE_LAUNCHER':    6.0,
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
 *  otherwise the Math.max(1, 3*scale) default ensures a minimum visible
 *  ring even at very small scales. */
export function resolveRingRadius(
  platformVariant: string | null | undefined,
  scale: number,
): number {
  const footprint = resolveFootprintRadius(platformVariant);
  if (footprint !== undefined) {
    return Math.max(1, footprint * scale);
  }
  return Math.max(1, 3 * scale);
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
