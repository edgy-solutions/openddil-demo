// Pin the co-location layout math. Visual regression class: if anyone
// "simplifies" the radius formula or changes COLOC_MIN_SPACING without
// re-validating that adjacent launcher schematics still clear each
// other, the Regional 3D map renders overlapping silhouettes again
// (commit 927a738 was the original fix; reverting it silently is a
// real risk).
import { describe, expect, it } from 'vitest';
import {
  colocationBucketKey,
  colocationRingRadius,
  colocationRingSlot,
  isFacilityVariant,
  COLOC_MIN_SPACING,
  COLOC_BUCKET,
  FACILITY_RING_MIN_RADIUS,
  FACILITY_VARIANTS,
} from '../coLocationLayout';

describe('constants — load-bearing values', () => {
  it('COLOC_MIN_SPACING is 2.5 (tuned against launcher schematic footprint)', () => {
    // The exact value is the dial — pin it so a change is intentional.
    expect(COLOC_MIN_SPACING).toBe(2.5);
  });
  it('COLOC_BUCKET (0.5) is well below COLOC_MIN_SPACING (no spurious merges)', () => {
    expect(COLOC_BUCKET).toBe(0.5);
    expect(COLOC_BUCKET).toBeLessThan(COLOC_MIN_SPACING);
  });
  it('FACILITY_RING_MIN_RADIUS (4.0) clears the MilitaryFacilitySchematic pad', () => {
    // 5×6 native pad at scale 0.35 -> half-diagonal ~1.37 world.
    // 4.0 leaves room for the ring asset's own footprint + buffer.
    expect(FACILITY_RING_MIN_RADIUS).toBe(4.0);
    expect(FACILITY_RING_MIN_RADIUS).toBeGreaterThan(1.5);
  });
});

describe('colocationBucketKey — same-point detection grain', () => {
  it('rounds (x, z) to COLOC_BUCKET grid', () => {
    // 0.5 grid -> values within 0.25 of a grid point round to that
    // point (Math.round half-to-even is fine here for our positive
    // domain; tests cover whole and half-grid values).
    expect(colocationBucketKey(0, 0)).toBe('0|0');
    expect(colocationBucketKey(0.5, 0)).toBe('1|0');     // 1.0 / bucket
    expect(colocationBucketKey(1.0, 0)).toBe('2|0');
    expect(colocationBucketKey(0.24, 0.24)).toBe('0|0'); // both round down
    expect(colocationBucketKey(0.26, 0.26)).toBe('1|1'); // both round up
  });

  it('two assets within COLOC_BUCKET land in the same bucket', () => {
    // Floating-point projection noise on lat/lon shouldn't separate
    // co-located assets. Anything within ~0.5 world units is "same FOB."
    const a = colocationBucketKey(10.0, -5.0);
    const b = colocationBucketKey(10.05, -5.1);  // 0.05 / 0.1 wiggle
    expect(a).toBe(b);
  });

  it('two assets COLOC_MIN_SPACING apart land in different buckets', () => {
    // If the bucket grain were as wide as COLOC_MIN_SPACING, the
    // stagger would re-merge buckets after positioning them — guard
    // against that via this inequality.
    const a = colocationBucketKey(0, 0);
    const b = colocationBucketKey(COLOC_MIN_SPACING, 0);
    expect(a).not.toBe(b);
  });

  it('negative coordinates handled symmetrically', () => {
    expect(colocationBucketKey(-1.0, -1.0)).toBe('-2|-2');
    expect(colocationBucketKey(-0.5, -0.5)).toBe('-1|-1');
  });
});

describe('colocationRingRadius — ring sizing per asset count', () => {
  it('few assets -> floor radius (geometric term is small)', () => {
    // n=3, no facility: geometric = 3*2.5/2π ≈ 1.19. Floor = 2.5.
    expect(colocationRingRadius(3, false)).toBe(COLOC_MIN_SPACING);
  });

  it('many assets -> geometric term dominates', () => {
    // n=20, no facility: geometric = 20*2.5/2π ≈ 7.96. Floor = 2.5.
    // Geometric wins; should equal the geometric value.
    const r = colocationRingRadius(20, false);
    expect(r).toBeCloseTo((20 * COLOC_MIN_SPACING) / (2 * Math.PI), 4);
    expect(r).toBeGreaterThan(COLOC_MIN_SPACING);
  });

  it('with facility at center -> at least FACILITY_RING_MIN_RADIUS', () => {
    // n=3, facility: geometric ≈ 1.19 but floor is 4.0. Floor wins.
    expect(colocationRingRadius(3, true)).toBe(FACILITY_RING_MIN_RADIUS);
  });

  it('with facility + many assets -> geometric still applies if larger', () => {
    // n=20, facility: geometric ≈ 7.96 > floor 4.0. Geometric wins.
    const r = colocationRingRadius(20, true);
    expect(r).toBeCloseTo((20 * COLOC_MIN_SPACING) / (2 * Math.PI), 4);
    expect(r).toBeGreaterThan(FACILITY_RING_MIN_RADIUS);
  });

  it('adjacent slots stay >= COLOC_MIN_SPACING apart at the geometric-dominated radius', () => {
    // The whole point of the geometric term: at large n, the ring
    // expands so the arc-length between adjacent slots stays at
    // COLOC_MIN_SPACING. Verify for n=10.
    const n = 10;
    const r = colocationRingRadius(n, false);
    const slotA = colocationRingSlot(0, 0, r, 0, n);
    const slotB = colocationRingSlot(0, 0, r, 1, n);
    const dx = slotA.x - slotB.x;
    const dz = slotA.z - slotB.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Geometric radius gives arc-length = COLOC_MIN_SPACING; chord
    // length is slightly less but very close for adjacent slots.
    expect(dist).toBeGreaterThan(COLOC_MIN_SPACING * 0.95);
  });

  it('n=1 special case: just the floor', () => {
    expect(colocationRingRadius(1, false)).toBe(COLOC_MIN_SPACING);
    expect(colocationRingRadius(1, true)).toBe(FACILITY_RING_MIN_RADIUS);
  });

  it('n=0 returns the floor (defensive, even though buildRenderables guards)', () => {
    expect(colocationRingRadius(0, false)).toBe(COLOC_MIN_SPACING);
    expect(colocationRingRadius(0, true)).toBe(FACILITY_RING_MIN_RADIUS);
  });
});

describe('colocationRingSlot — per-slot positioning around the centroid', () => {
  it('i=0, n=4 -> east of centroid', () => {
    const s = colocationRingSlot(10, 20, 5, 0, 4);
    expect(s.x).toBeCloseTo(15, 4);  // 10 + cos(0)*5
    expect(s.z).toBeCloseTo(20, 4);  // 20 + sin(0)*5
  });

  it('i=1, n=4 -> north of centroid', () => {
    // angle = (1/4)*2π = π/2; cos = 0, sin = 1
    const s = colocationRingSlot(10, 20, 5, 1, 4);
    expect(s.x).toBeCloseTo(10, 4);
    expect(s.z).toBeCloseTo(25, 4);
  });

  it('i=2, n=4 -> west of centroid', () => {
    const s = colocationRingSlot(10, 20, 5, 2, 4);
    expect(s.x).toBeCloseTo(5, 4);
    expect(s.z).toBeCloseTo(20, 4);
  });

  it('slots are equidistant from centroid', () => {
    const cx = 10, cz = 20, r = 7;
    for (let i = 0; i < 8; i++) {
      const s = colocationRingSlot(cx, cz, r, i, 8);
      const dx = s.x - cx;
      const dz = s.z - cz;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeCloseTo(r, 4);
    }
  });

  it('slot i wraps cleanly around 2π (i and i+n produce same position)', () => {
    // The formula is angle = (i/n) * 2π. i=n -> angle = 2π = full
    // rotation. Equivalent to i=0.
    const a = colocationRingSlot(0, 0, 5, 0, 4);
    const b = colocationRingSlot(0, 0, 5, 4, 4);
    expect(a.x).toBeCloseTo(b.x, 4);
    expect(a.z).toBeCloseTo(b.z, 4);
  });
});

describe('isFacilityVariant — facility classification', () => {
  it.each(Array.from(FACILITY_VARIANTS))('"%s" is a facility', (variant) => {
    expect(isFacilityVariant(variant)).toBe(true);
  });

  it.each([
    'CUAS_Sensor', 'MRAD_Sensor',
    'CUAS_Interceptor', 'MRAD_Interceptor', 'MISSILE_LAUNCHER',
    'M1A2-SEPv3', 'AH-64E',
    'UNKNOWN',
  ])('"%s" is NOT a facility', (variant) => {
    expect(isFacilityVariant(variant)).toBe(false);
  });

  it('null platform_variant is NOT a facility (defensive)', () => {
    expect(isFacilityVariant(null)).toBe(false);
  });

  it('undefined platform_variant is NOT a facility', () => {
    expect(isFacilityVariant(undefined)).toBe(false);
  });

  it('empty string is NOT a facility', () => {
    expect(isFacilityVariant('')).toBe(false);
  });
});
