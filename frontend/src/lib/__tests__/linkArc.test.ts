import { describe, expect, it } from 'vitest';
import { fadeAlphas, linkArc } from '../linkArc';

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

  it('stays 3 above a bump in the ground away from the ends', () => {
    const bump = (x: number) => (x > 40 && x < 60 ? 50 : 0);
    const a = linkArc([0, 0, 0], [100, 0, 0], bump);
    for (const [x, y] of a) if (x >= 15 && x <= 85) expect(y).toBeGreaterThanOrEqual(bump(x) + 3 - 1e-9);
    expect(a.some(([x, y]) => x > 40 && x < 60 && y >= 53)).toBe(true);
  });

  it('does not produce NaN for a zero-length link', () => {
    const a = linkArc([5, 2, 5], [5, 2, 5], flat);
    expect(a).toHaveLength(49);
    for (const p of a) for (const v of p) expect(Number.isNaN(v)).toBe(false);
  });

  it('ends exactly at start and end even when the ground is above them', () => {
    const a = linkArc([0, 1, 0], [100, 2, 0], () => 50);
    expect(a[0]).toEqual([0, 1, 0]);
    expect(a[48]).toEqual([100, 2, 0]);
  });

  it('keeps the clearance above the ground in the middle, and honours a custom one', () => {
    const hill = () => 20;
    for (const c of [3, 0.15, 10]) {
      const a = linkArc([0, 0, 0], [100, 0, 0], hill, 48, c);
      for (let i = 8; i <= 40; i++) expect(a[i][1]).toBeGreaterThanOrEqual(20 + c - 1e-9);
    }
    const lo = linkArc([0, 0, 0], [100, 0, 0], () => 20, 48, 0.15);
    expect(lo[24][1]).toBeLessThan(20 + 0.15 + 0.06 * 100 + 1e-9);
  });

  it('eases the clearance in near the ends', () => {
    const a = linkArc([0, 0, 0], [100, 0, 0], () => 5, 48, 3);
    expect(a[1][1]).toBeLessThan(5 + 3);
  });
});

describe('fadeAlphas', () => {
  it('is all 1 without a fade', () => {
    expect(fadeAlphas(5, 0)).toEqual([1, 1, 1, 1, 1]);
  });
  it('holds 1 until 1 - fadeEnd, then ramps linearly to 0 at the last point', () => {
    const a = fadeAlphas(11, 0.3);
    expect(a[0]).toBe(1);
    expect(a[7]).toBe(1);
    expect(a[8]).toBeCloseTo(2 / 3, 9);
    expect(a[9]).toBeCloseTo(1 / 3, 9);
    expect(a[10]).toBe(0);
  });
  it('fades the whole line at fadeEnd 1', () => {
    expect(fadeAlphas(3, 1)).toEqual([1, 0.5, 0]);
  });
});
