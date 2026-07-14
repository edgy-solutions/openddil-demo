// =============================================================================
// assetClass — first-class discriminator layered over platform_variant
// =============================================================================
// The customer's ORBAT enum blurs together things that behave very
// differently from a logistics standpoint:
//
//   * A radar (SENSOR) is long-lived hardware -- availability, CM, wear.
//   * A launcher (LAUNCHER) is long-lived hardware whose primary
//     concern is stockpile-of-effectors, not just its own health.
//   * A fired missile (MUNITION) is a transient physics object with
//     kinematics for ~seconds until it hits its target. It has no
//     BIT, no CM state, no wear trend -- and yet it appears in
//     telemetry_latest_state with a *_Interceptor platform_variant
//     until its TTL expires.
//   * A facility (FACILITY) is fixed infrastructure -- posture, not
//     wear-out.
//   * Everything else (PLATFORM) is the legacy DIS fleet (M1A2, AH-64E)
//     or a genuinely unfamiliar variant.
//
// This file derives the class client-side from the pair
// (platform_variant, hasCapability) so we don't need a server-side
// column or view for the display split. Both signals are already
// streaming to the frontend via useFleetAssets + useCapabilityRoster.
//
// KEY DISCRIMINATOR: a LAUNCHER is defined as "emits a weapons-capability
// snapshot" (i.e., appears in asset_capability_state). Fired munitions
// land in telemetry_latest_state but never in asset_capability_state --
// so the presence check cleanly separates the two even when they share
// a platform_variant. The canonical shape is designed from open sources
// (DIS Fire/Detonation PDUs, AFSim stores modeling, Link 16 J3.7 weapon
// status); source-specific decompositions land in this shape at the
// Bloblang layer.
//
// Suffix-family fallback: `*_Sensor` -> SENSOR, `*_Interceptor` or
// `MISSILE_LAUNCHER` (and no capability) -> MUNITION. Adding a new
// tier (MRAD_ADVANCED, HYPERSONIC_MRAD, ...) that follows the
// convention needs no code change here -- pairs with the
// resolveSchematic() suffix-family fallback in platform-schematics/
// index.tsx (2026-07-13).
// =============================================================================

export type AssetClass =
  | 'SENSOR'
  | 'LAUNCHER'
  | 'MUNITION'
  | 'FACILITY'
  | 'PLATFORM'
  | 'UNKNOWN';

// ORBAT facilities are a closed enum today. If the customer adds a new
// facility variant, add it here (or extend the classifier to consult
// the schematic-registry facility list).
const FACILITY_VARIANTS: ReadonlySet<string> = new Set([
  'AIR_DEFENSE_SITE',
  'HEADQUARTER_COMPLEX',
  'INSTALLATION_FACILITY_CIVILIAN',
]);

// Munition-candidate variants. An asset with one of these variants that
// ALSO emits a weapons-capability snapshot is a LAUNCHER; without
// capability, it's a fired-and-in-flight MUNITION.
function isMunitionCandidateVariant(variant: string): boolean {
  return variant === 'MISSILE_LAUNCHER' || variant.endsWith('_Interceptor');
}

/**
 * Classify one asset. Precedence order:
 *   1. No variant known               -> UNKNOWN
 *   2. Variant ends `_Sensor`         -> SENSOR
 *   3. Variant is a facility          -> FACILITY
 *   4. Asset emits capability snapshot -> LAUNCHER  (definitive)
 *   5. Variant is munition-candidate  -> MUNITION  (fired-in-flight)
 *   6. Fallthrough                    -> PLATFORM
 *
 * `hasCapability` = true iff the asset appears in asset_capability_state
 * (i.e. the customer's weapons-capability feed carries it).
 */
export function classifyAsset(
  variant: string | null | undefined,
  hasCapability: boolean,
): AssetClass {
  if (!variant) return 'UNKNOWN';
  if (variant.endsWith('_Sensor')) return 'SENSOR';
  if (FACILITY_VARIANTS.has(variant)) return 'FACILITY';
  if (hasCapability) return 'LAUNCHER';
  if (isMunitionCandidateVariant(variant)) return 'MUNITION';
  return 'PLATFORM';
}

/** Human-facing label for the class -- consistent across cards. */
export function assetClassLabel(cls: AssetClass): string {
  switch (cls) {
    case 'SENSOR':   return 'Sensors';
    case 'LAUNCHER': return 'Launchers';
    case 'MUNITION': return 'Munitions';
    case 'FACILITY': return 'Facilities';
    case 'PLATFORM': return 'Platforms';
    case 'UNKNOWN':  return 'Unresolved';
  }
}
