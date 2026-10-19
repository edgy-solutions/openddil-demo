// Pin the same-point bucketing grain the Regional map clusters by.
import { describe, expect, it } from 'vitest';
import { colocationBucketKey, COLOC_BUCKET } from '../coLocationLayout';

describe('COLOC_BUCKET', () => {
  it('is 0.5 world units (~700 m), above projection float noise', () => {
    expect(COLOC_BUCKET).toBe(0.5);
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

  it('two assets one bucket apart land in different buckets', () => {
    const a = colocationBucketKey(0, 0);
    const b = colocationBucketKey(COLOC_BUCKET, 0);
    expect(a).not.toBe(b);
  });

  it('negative coordinates handled symmetrically', () => {
    expect(colocationBucketKey(-1.0, -1.0)).toBe('-2|-2');
    expect(colocationBucketKey(-0.5, -0.5)).toBe('-1|-1');
  });
});
