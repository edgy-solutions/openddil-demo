import { describe, expect, it } from 'vitest';
import { linkArc } from '../linkArc';

const flat = () => 0;

describe('linkArc', () => {
  it('returns n + 1 points with exact endpoints', () => {
    const a = linkArc([1.1, 0, -2.3], [301.7, 0, 400.9], () => -10);
    expect(a).toHaveLength(49);
    expect(a[0]).toEqual([1.1, 0, -2.3]);
    expect(a[48]).toEqual([301.7, 0, 400.9]);
    expect(linkArc([0, 0, 0], [10, 0, 0], flat, 10)).toHaveLength(11);
  });

  it('rises 6% of the horizontal length at the midpoint on flat ground', () => {
    const a = linkArc([0, 0, 0], [300, 0, 400], flat);
    expect(a[24][1]).toBeCloseTo(0.06 * 500, 9);
  });

  it('follows the endpoints in height', () => {
    const a = linkArc([0, 10, 0], [100, 30, 0], flat);
    expect(a[24][1]).toBeCloseTo(20 + 6, 9);
  });

  it('stays 3 above a bump in the ground', () => {
    const bump = (x: number) => (x > 40 && x < 60 ? 50 : 0);
    const a = linkArc([0, 0, 0], [100, 0, 0], bump);
    for (const [x, y] of a) expect(y).toBeGreaterThanOrEqual(bump(x) + 3 - 1e-9);
    expect(a.some(([x, y]) => x > 40 && x < 60 && y >= 53)).toBe(true);
  });

  it('does not produce NaN for a zero-length link', () => {
    const a = linkArc([5, 2, 5], [5, 2, 5], flat);
    expect(a).toHaveLength(49);
    for (const p of a) for (const v of p) expect(Number.isNaN(v)).toBe(false);
  });
});
