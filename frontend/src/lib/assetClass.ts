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
// This file derives the class client-side from the platform_variant plus
// three pieces of evidence (see classifyAsset) so we don't need a
// server-side column or view for the display split. The signals already
// stream to the frontend via useFleetAssets, useCapabilityRoster and
// useMunitionLaunches.
//
// KEY DISCRIMINATORS: a LAUNCHER emits a weapons-capability snapshot
// (appears in asset_capability_state). A fired MUNITION is the child
// track named by an effector_launch row (munition_asset_id). The launch
// row is the definitive in-flight evidence. The mere ABSENCE of a
// capability row is only evidence of a munition while the capability
// feed is alive (has rows at all); on a deployment with no capability
// feed every launcher lacks a row, so absence says nothing and
// launchers must stay launchers. The canonical shape is designed from
// open sources (DIS Fire/Detonation PDUs, AFSim stores modeling, Link 16
// J3.7 weapon status); source-specific decompositions land in this shape
// at the Bloblang layer.
//
// Suffix-family fallback: `*_Sensor` -> SENSOR, `*_Interceptor` or
// `MISSILE_LAUNCHER` -> LAUNCHER or MUNITION per the evidence above.
// Adding a new tier (MRAD_ADVANCED, HYPERSONIC_MRAD, ...) that follows
// the convention needs no code change here -- pairs with the
// resolveSchematic() suffix-family fallback in platform-schematics/
// index.tsx.
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

// Munition-candidate variants. Such an asset is a LAUNCHER unless there
// is evidence it fired (a launch row, or a live capability feed that
// does not list it).
function isMunitionCandidateVariant(variant: string): boolean {
  return variant === 'MISSILE_LAUNCHER' || variant.endsWith('_Interceptor');
}

export interface AssetClassEvidence {
  /** Asset appears in asset_capability_state. */
  hasCapability: boolean;
  /** asset_capability_state has at least one row (the feed exists). */
  capabilityFeedAlive: boolean;
  /** Asset id appears as munition_asset_id in an effector_launch row. */
  isLaunchedMunition: boolean;
}

/**
 * Classify one asset. Precedence order:
 *   1. No variant known                -> UNKNOWN
 *   2. Variant ends `_Sensor`          -> SENSOR
 *   3. Variant is a facility           -> FACILITY
 *   4. Asset emits capability snapshot -> LAUNCHER  (definitive)
 *   5. Asset is a declared launch munition -> MUNITION (definitive)
 *   6. Munition-candidate variant      -> MUNITION while the capability
 *      feed has rows (and omits this asset), otherwise LAUNCHER: with
 *      no feed, a missing capability row is not evidence of a missile.
 *   7. Fallthrough                     -> PLATFORM
 */
export function classifyAsset(
  variant: string | null | undefined,
  evidence: AssetClassEvidence,
): AssetClass {
  if (!variant) return 'UNKNOWN';
  if (variant.endsWith('_Sensor')) return 'SENSOR';
  if (FACILITY_VARIANTS.has(variant)) return 'FACILITY';
  if (evidence.hasCapability) return 'LAUNCHER';
  if (evidence.isLaunchedMunition) return 'MUNITION';
  if (isMunitionCandidateVariant(variant)) {
    return evidence.capabilityFeedAlive ? 'MUNITION' : 'LAUNCHER';
  }
  return 'PLATFORM';
}

/**
 * Build a per-asset classifier from the capability and launch rows. The
 * id Sets are built once, so the returned function is O(1) per asset.
 */
export function makeAssetClassifier(
  capabilityRows: ReadonlyArray<{ asset_id: string }>,
  launchRows: ReadonlyArray<{ munition_asset_id: string | null }>,
): (asset: { asset_id: string; platform_variant: string | null | undefined }) => AssetClass {
  const capabilityIds = new Set(capabilityRows.map((c) => c.asset_id));
  const launchedIds = new Set<string>();
  for (const l of launchRows) {
    if (l.munition_asset_id) launchedIds.add(l.munition_asset_id);
  }
  const capabilityFeedAlive = capabilityRows.length > 0;
  return (a) =>
    classifyAsset(a.platform_variant, {
      hasCapability: capabilityIds.has(a.asset_id),
      capabilityFeedAlive,
      isLaunchedMunition: launchedIds.has(a.asset_id),
    });
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
