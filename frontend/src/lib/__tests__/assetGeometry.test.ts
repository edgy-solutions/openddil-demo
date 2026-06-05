// Pin the per-platform geometry tables that drive the visible
// invariants in the regional 3D map. These constants were tuned
// visually over several rounds of operator feedback (commits 359441c,
// dcfc97c, 0c3c9a3); silently changing one shifts asset rendering
// in ways that are easy to miss in TypeScript review.
//
// What this suite guards against:
//   * Adding a new variant to ASSET_HEIGHT but forgetting
//     GROUND_OFFSET (asset would render half-buried at the wrong
//     elevation).
//   * "Simplifying" launcher pad height to a round number that
//     breaks the hinge-sits-on-pad invariant — the launcher would
//     float again like commit dcfc97c originally fixed.
//   * Reducing launcher ASSET_HEIGHT below the peak-tilt back-top
//     corner — spotlight cylinder clips the launcher again.
//   * Swapping pad radius and footprint radius — pod merges into
//     pad again like the operator reported in commit 0c3c9a3.
import { describe, expect, it } from 'vitest';
import {
  GROUND_OFFSET,
  ASSET_HEIGHT,
  ASSET_FOOTPRINT_RADIUS,
  LAUNCH_PADS,
  PAD_RADIUS_NATIVE,
  DEFAULT_GROUND_OFFSET,
  DEFAULT_ASSET_HEIGHT,
  ASSET_VARIANT_SCALE,
  DEFAULT_VARIANT_SCALE,
  resolveGroundOffset,
  resolveAssetHeight,
  resolveFootprintRadius,
  resolvePadHeight,
  resolvePadRadius,
  resolveRingRadius,
  resolvePadWorldRadius,
  resolveVariantScale,
} from '../assetGeometry';

// ArtillerySchematic native geometry — referenced in multiple tests.
// Mirrors the source-of-truth values in ArtillerySchematic.tsx.
const HINGE_NATIVE_BOTTOM = -2.5;        // hinge box -2..-2.5 at Y=-2
const POD_PEAK_TILT_TOP_NATIVE = 4.1;    // back-top corner at θ=0.7 rad
const POD_HALF_WIDTH_NATIVE = 2.25;      // pod box 4.5 wide
const POD_HALF_DEPTH_NATIVE = 3.5;       // pod box 7 deep
const POD_TOP_DOWN_HALF_DIAGONAL =
  Math.sqrt(POD_HALF_WIDTH_NATIVE ** 2 + POD_HALF_DEPTH_NATIVE ** 2);

const LAUNCHER_VARIANTS = [
  'CUAS_Interceptor', 'VSHORAD_Interceptor',
  'SHORAD_Interceptor', 'MRAD_Interceptor',
  'MISSILE_LAUNCHER',
] as const;

// ---------------------------------------------------------------------------
// Cross-table invariants
// ---------------------------------------------------------------------------

describe('cross-table — every ASSET_HEIGHT variant has a GROUND_OFFSET', () => {
  // If a future PR adds a new variant to ASSET_HEIGHT but forgets
  // GROUND_OFFSET, the asset renders at the DEFAULT_GROUND_OFFSET
  // (1.6) instead of its actual lowest-point Y — looks half-buried
  // or floating. This test fails loud at PR time instead.
  it.each(Object.keys(ASSET_HEIGHT))('"%s" has a GROUND_OFFSET entry', (variant) => {
    expect(GROUND_OFFSET).toHaveProperty(variant);
  });
});

describe('cross-table — every launcher table is consistent', () => {
  // All five launcher tables (GROUND_OFFSET, ASSET_HEIGHT,
  // ASSET_FOOTPRINT_RADIUS, LAUNCH_PADS, PAD_RADIUS_NATIVE) must
  // each cover all five launcher variants. Asymmetry between tables
  // = inconsistent rendering across the launcher family.
  it.each(LAUNCHER_VARIANTS)('"%s" has every launcher-specific entry', (variant) => {
    expect(GROUND_OFFSET).toHaveProperty(variant);
    expect(ASSET_HEIGHT).toHaveProperty(variant);
    expect(ASSET_FOOTPRINT_RADIUS).toHaveProperty(variant);
    expect(LAUNCH_PADS).toHaveProperty(variant);
    expect(PAD_RADIUS_NATIVE).toHaveProperty(variant);
  });
});

// ---------------------------------------------------------------------------
// Launcher invariants — the geometry that took 3 commits to tune
// ---------------------------------------------------------------------------

describe('launcher invariants — hinge-sits-on-pad', () => {
  // After the GROUND_OFFSET lift, the launcher's hinge native bottom
  // (-2.5) lands at world Y = (groundOffset - 2.5) * scale. The pad
  // must be exactly that tall so the hinge sits ON pad top (no
  // float). Original bug from commit 359441c onward; pinned here.
  it.each(LAUNCHER_VARIANTS)('"%s" pad height = groundOffset - hingeBottom', (variant) => {
    const groundOffset = GROUND_OFFSET[variant];
    const padHeight = LAUNCH_PADS[variant];
    expect(padHeight).toBe(groundOffset - HINGE_NATIVE_BOTTOM * -1);
    // equivalently: padHeight == groundOffset + HINGE_NATIVE_BOTTOM == 4.5 + (-2.5) = 2.0
    expect(padHeight).toBe(groundOffset + HINGE_NATIVE_BOTTOM);
  });
});

describe('launcher invariants — spotlight cylinder clears peak tilt', () => {
  // The spotlight cylinder height = ASSET_HEIGHT * scale * 1.15 (per
  // SeverityBaseRing). It must enclose the launcher's peak-tilt
  // back-top corner. The peak corner lands at world Y =
  // (groundOffset + POD_PEAK_TILT_TOP) * scale. Cylinder top at
  // ASSET_HEIGHT * scale * 1.15. Inequality: cylinder must clear it.
  it.each(LAUNCHER_VARIANTS)('"%s" cylinder height >= peak-tilt top', (variant) => {
    const groundOffset = GROUND_OFFSET[variant];
    const assetHeight = ASSET_HEIGHT[variant];
    const peakTopWorldAtUnitScale = groundOffset + POD_PEAK_TILT_TOP_NATIVE;
    const cylinderTopAtUnitScale = assetHeight * 1.15;
    expect(cylinderTopAtUnitScale).toBeGreaterThanOrEqual(peakTopWorldAtUnitScale);
  });
});

describe('launcher invariants — pad sized to hinge, ring sized to pod', () => {
  // Pad radius < footprint radius is the contract that lets the pod
  // sweep freely past pad edges during peak tilt (per commit 0c3c9a3
  // operator feedback). Earlier the pad was tied to footprint and
  // the pod merged into the pad mesh.
  it.each(LAUNCHER_VARIANTS)('"%s" PAD_RADIUS_NATIVE < ASSET_FOOTPRINT_RADIUS', (variant) => {
    expect(PAD_RADIUS_NATIVE[variant]).toBeLessThan(ASSET_FOOTPRINT_RADIUS[variant]);
  });

  it('launcher pad radius (2.0) is sized to the hinge base (4×4 native)', () => {
    // Hinge half-width is 2.0 (4/2). Pad radius 2.0 means the pad
    // circle just inscribes the hinge square. Pin the literal so a
    // refactor away from 2.0 catches the eye.
    LAUNCHER_VARIANTS.forEach(v => expect(PAD_RADIUS_NATIVE[v]).toBe(2.0));
  });

  it('launcher footprint radius (6.0) exceeds pod top-down half-diagonal', () => {
    // Pod top-down half-diagonal ≈ 4.16 native. Footprint 6.0 means
    // the outer halo (footprint * scale * 1.5) clearly exceeds the
    // pod outline at any scale. Pinned per the comment in
    // assetGeometry.ts.
    LAUNCHER_VARIANTS.forEach((v) => {
      expect(ASSET_FOOTPRINT_RADIUS[v]).toBeGreaterThan(POD_TOP_DOWN_HALF_DIAGONAL);
    });
  });
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe('resolveGroundOffset', () => {
  it('returns the per-variant value when present', () => {
    expect(resolveGroundOffset('MRAD_Sensor')).toBe(1.1);
    expect(resolveGroundOffset('MISSILE_LAUNCHER')).toBe(4.5);
  });
  it('returns DEFAULT_GROUND_OFFSET (1.6) on null platform_variant', () => {
    expect(resolveGroundOffset(null)).toBe(DEFAULT_GROUND_OFFSET);
  });
  it('returns DEFAULT_GROUND_OFFSET on unaliased variant (UNKNOWN)', () => {
    expect(resolveGroundOffset('UNKNOWN')).toBe(DEFAULT_GROUND_OFFSET);
  });
  it('returns DEFAULT_GROUND_OFFSET on undefined', () => {
    expect(resolveGroundOffset(undefined)).toBe(DEFAULT_GROUND_OFFSET);
  });
});

describe('resolveAssetHeight', () => {
  it('returns the per-variant value when present', () => {
    expect(resolveAssetHeight('MRAD_Sensor')).toBe(4.2);
    expect(resolveAssetHeight('MISSILE_LAUNCHER')).toBe(8.0);
  });
  it('returns DEFAULT_ASSET_HEIGHT (3.2) on null/unknown', () => {
    expect(resolveAssetHeight(null)).toBe(DEFAULT_ASSET_HEIGHT);
    expect(resolveAssetHeight('UNKNOWN_VARIANT')).toBe(DEFAULT_ASSET_HEIGHT);
  });
});

describe('resolveFootprintRadius / resolvePadHeight / resolvePadRadius', () => {
  // Distinct from the *_HEIGHT/_OFFSET resolvers: these return
  // undefined (not a default) on miss, so callers can branch on
  // "has override" vs "use generic floor."
  it('launcher variants return numeric footprint, pad height, pad radius', () => {
    expect(resolveFootprintRadius('MRAD_Interceptor')).toBe(6.0);
    expect(resolvePadHeight('MRAD_Interceptor')).toBe(2.0);
    expect(resolvePadRadius('MRAD_Interceptor')).toBe(2.0);
  });
  it('non-launcher variants return undefined', () => {
    expect(resolveFootprintRadius('MRAD_Sensor')).toBeUndefined();
    expect(resolvePadHeight('MRAD_Sensor')).toBeUndefined();
    expect(resolvePadRadius('MRAD_Sensor')).toBeUndefined();
    expect(resolveFootprintRadius('M1A2-SEPv3')).toBeUndefined();
    expect(resolvePadHeight('AIR_DEFENSE_SITE')).toBeUndefined();
  });
  it('null platform_variant returns undefined', () => {
    expect(resolveFootprintRadius(null)).toBeUndefined();
    expect(resolvePadHeight(null)).toBeUndefined();
    expect(resolvePadRadius(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composite calculators
// ---------------------------------------------------------------------------

describe('resolveRingRadius', () => {
  // The min radius is 1.0 (literal Math.max in the helper) so small-
  // scale rendering still shows a visible ring.
  it('launcher at scale 0.35 -> 2.1 (footprint override)', () => {
    expect(resolveRingRadius('MRAD_Interceptor', 0.35)).toBeCloseTo(6.0 * 0.35, 4);
  });
  it('sensor at scale 0.35 -> ~1.05 (default 3*scale path)', () => {
    expect(resolveRingRadius('MRAD_Sensor', 0.35)).toBeCloseTo(Math.max(1, 3 * 0.35), 4);
  });
  it('floor of 1.0 enforced at very small scale', () => {
    expect(resolveRingRadius('MRAD_Sensor', 0.1)).toBe(1.0);   // 3*0.1=0.3 < 1
    expect(resolveRingRadius(null, 0.1)).toBe(1.0);
  });
  it('null platform_variant uses default path', () => {
    expect(resolveRingRadius(null, 0.35)).toBeCloseTo(Math.max(1, 3 * 0.35), 4);
  });
});

describe('resolvePadWorldRadius', () => {
  it('launcher at scale 0.35 -> 0.7 (per-variant native 2.0 * scale)', () => {
    expect(resolvePadWorldRadius('MRAD_Interceptor', 0.35)).toBeCloseTo(2.0 * 0.35, 4);
  });
  it('non-launcher at scale 0.35 -> 0.9 floor (generic 2.5*scale = 0.875 < 0.9)', () => {
    expect(resolvePadWorldRadius('MRAD_Sensor', 0.35)).toBe(0.9);
  });
  it('large scale: generic 2.5*scale beats 0.9 floor', () => {
    expect(resolvePadWorldRadius('MRAD_Sensor', 1.0)).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// Catalog completeness
// ---------------------------------------------------------------------------

describe('catalog — all expected ORBAT variants present', () => {
  // The customer ORBAT enum is closed at 12 entries (4 sensor tiers,
  // 4 interceptor tiers, 1 launcher, 3 facility types). Plus 3
  // legacy DIS. All should appear in GROUND_OFFSET + ASSET_HEIGHT.
  const expected = [
    'CUAS_Sensor', 'VSHORAD_Sensor', 'SHORAD_Sensor', 'MRAD_Sensor',
    'CUAS_Interceptor', 'VSHORAD_Interceptor', 'SHORAD_Interceptor', 'MRAD_Interceptor',
    'MISSILE_LAUNCHER',
    'AIR_DEFENSE_SITE', 'HEADQUARTER_COMPLEX', 'INSTALLATION_FACILITY_CIVILIAN',
    'M1A2-SEPv3', 'M1A2-SEPv2', 'AH-64E',
  ];
  it.each(expected)('"%s" is in GROUND_OFFSET', (v) => {
    expect(GROUND_OFFSET).toHaveProperty(v);
  });
  it.each(expected)('"%s" is in ASSET_HEIGHT', (v) => {
    expect(ASSET_HEIGHT).toHaveProperty(v);
  });
});


// ---------------------------------------------------------------------------
// ASSET_VARIANT_SCALE -- per-variant visual-scale multiplier
// ---------------------------------------------------------------------------

describe("ASSET_VARIANT_SCALE -- per-variant visual scale", () => {
  it("DEFAULT_VARIANT_SCALE is 1.0 (no implicit shrink/grow)", () => {
    expect(DEFAULT_VARIANT_SCALE).toBe(1.0);
  });

  it("resolveVariantScale returns DEFAULT for variants with no entry", () => {
    // Sensors are not in the table -- they look right at base scale.
    expect(resolveVariantScale("CUAS_Sensor")).toBe(DEFAULT_VARIANT_SCALE);
    expect(resolveVariantScale("MRAD_Sensor")).toBe(DEFAULT_VARIANT_SCALE);
    expect(resolveVariantScale("M1A2-SEPv3")).toBe(DEFAULT_VARIANT_SCALE);
    expect(resolveVariantScale("HEADQUARTER_COMPLEX")).toBe(DEFAULT_VARIANT_SCALE);
  });

  it("resolveVariantScale returns DEFAULT for null / undefined / unknown", () => {
    expect(resolveVariantScale(null)).toBe(DEFAULT_VARIANT_SCALE);
    expect(resolveVariantScale(undefined)).toBe(DEFAULT_VARIANT_SCALE);
    expect(resolveVariantScale("UNKNOWN_FUTURE_VARIANT")).toBe(DEFAULT_VARIANT_SCALE);
  });

  // The five launcher entries shrink uniformly. If a future tuning
  // changes them they should all change together -- assert that
  // the launcher row is internally consistent.
  it("all 5 launchers share the same visual-scale multiplier", () => {
    const launcherVariants = [
      "CUAS_Interceptor",
      "VSHORAD_Interceptor",
      "SHORAD_Interceptor",
      "MRAD_Interceptor",
      "MISSILE_LAUNCHER",
    ];
    const scales = launcherVariants.map((v) => resolveVariantScale(v));
    expect(new Set(scales).size).toBe(1);
  });

  it("launchers shrink (< 1.0) -- their native footprint is ~3x sensors", () => {
    // Floor at 0.4: anything smaller would make the launcher visibly
    // smaller than a CUAS_Sensor at base scale, which is the opposite
    // problem of the original bug. Ceiling at 0.95: tightly < 1 to
    // confirm intentional shrink.
    const s = resolveVariantScale("MRAD_Interceptor");
    expect(s).toBeGreaterThanOrEqual(0.4);
    expect(s).toBeLessThan(0.95);
  });

  it("ASSET_VARIANT_SCALE only contains entries that diverge from DEFAULT", () => {
    // Hygiene: a 1.0 entry is a no-op and clutters the table.
    for (const [variant, value] of Object.entries(ASSET_VARIANT_SCALE)) {
      expect(value, `${variant} should be removed from ASSET_VARIANT_SCALE if equal to DEFAULT`).not.toBe(DEFAULT_VARIANT_SCALE);
    }
  });
});
