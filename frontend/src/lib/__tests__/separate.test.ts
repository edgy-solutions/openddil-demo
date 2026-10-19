import { describe, expect, it } from 'vitest';
import { separate } from '../separate';

const D = 20;
const minPair = (p: [number, number][]) => {
  let m = Infinity;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) m = Math.min(m, Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]));
  return m;
};

describe('separate', () => {
  it('leaves separated points unchanged', () => {
    const pts: [number, number][] = [[0, 0], [30, 0], [0, 25]];
    expect(separate(pts, D)).toEqual(pts);
  });
  it('spreads two coincident points along x, centred', () => {
    const [a, b] = separate([[50, 40], [50, 40]], D);
    expect(a[0]).toBeCloseTo(40); expect(b[0]).toBeCloseTo(60);
    expect(a[1]).toBeCloseTo(40); expect(b[1]).toBeCloseTo(40);
  });
  it('spreads three coincident points into a centred row', () => {
    const r = separate([[0, 0], [0, 0], [0, 0]], D);
    expect(r.map((q) => q[0])).toEqual([-D, 0, D]);
    expect(r.every((q) => q[1] === 0)).toBe(true);
  });
  it('pushes an overlapping pair apart symmetrically, keeping the midpoint', () => {
    const [a, b] = separate([[0, 0], [D / 2, 0]], D);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(D);
    expect((a[0] + b[0]) / 2).toBeCloseTo(D / 4);
  });
  it('preserves x order of a row', () => {
    const r = separate([[0, 0], [5, 0], [10, 0], [15, 0]], D);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThan(r[i - 1][0]);
  });
  it('leaves no pair closer than minDist', () => {
    const r = separate([[0, 0], [3, 2], [6, -1], [2, 5], [1, 1]], D, 200);
    expect(minPair(r)).toBeGreaterThanOrEqual(D - 1e-6);
  });
});
