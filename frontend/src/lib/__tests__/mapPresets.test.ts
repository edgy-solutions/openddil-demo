import { describe, expect, it } from 'vitest';
import { assetFocus, buildPresets, controlsMaxDistance, launchView, type Vec3 } from '../mapPresets';

const pts: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 0, 6]];
const dist = (p: { target: Vec3; pos: Vec3 }) =>
  Math.hypot(p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]);

describe('buildPresets', () => {
  it('is empty with nothing to show', () => {
    expect(buildPresets({ points: [], clusters: [], launches: [] })).toEqual([]);
  });
  it('lists OVERVIEW, then clusters, then launches', () => {
    const ps = buildPresets({
      points: pts,
      clusters: [{ key: 'edge:a', label: 'FOB A', points: [[0, 0, 0], [0.1, 0, 0]] }],
      launches: [{ key: 'm1', callsign: 'L1', launcher: [0, 0, 0], dir: [0, -1] }],
    });
    expect(ps.map((p) => p.label)).toEqual(['OVERVIEW', 'FOB A', 'LAUNCH L1']);
  });
  it('overview looks at the bbox centre from above and south', () => {
    const [o] = buildPresets({ points: pts, clusters: [], launches: [] });
    expect(o.target).toEqual([5, 0, 3]);
    expect(o.pos[1]).toBeGreaterThan(0);
    expect(o.pos[2]).toBeGreaterThan(o.target[2]);
  });
  it('overview backs off as the area grows, capped under the controls max distance', () => {
    const near = buildPresets({ points: pts, clusters: [], launches: [] })[0];
    const far = buildPresets({ points: [[0, 0, 0], [5000, 0, 0]], clusters: [], launches: [] })[0];
    expect(dist(far)).toBeGreaterThan(dist(near));
    expect(dist(far)).toBeLessThanOrEqual(900);
  });
  it('a wide overview may pass 280 but never 900; a cluster still clamps at 280', () => {
    const wide: Vec3[] = [[0, 0, 0], [200, 0, 0]];
    expect(dist(buildPresets({ points: wide, clusters: [], launches: [] })[0])).toBeGreaterThan(280);
    const huge: Vec3[] = [[0, 0, 0], [50000, 0, 0]];
    expect(dist(buildPresets({ points: huge, clusters: [], launches: [] })[0])).toBeCloseTo(900, 6);
    const ps = buildPresets({ points: wide, clusters: [{ key: 'edge:a', label: 'A', points: huge }], launches: [] });
    expect(dist(ps[1])).toBeCloseTo(280, 6);
  });
  it('a portrait pane backs the overview off by the aspect ratio', () => {
    const a = [[0, 0, 0], [20, 0, 0]] as Vec3[];
    const tall = dist(buildPresets({ points: a, aspect: 0.5, clusters: [], launches: [] })[0]);
    const wide = dist(buildPresets({ points: a, aspect: 2, clusters: [], launches: [] })[0]);
    expect(tall).toBeCloseTo(2 * wide, 6);
  });
  it('controlsMaxDistance is 300 without an overview, else 1.15x the overview distance (min 300)', () => {
    expect(controlsMaxDistance([])).toBe(300);
    const near = buildPresets({ points: pts, clusters: [], launches: [] });
    expect(controlsMaxDistance(near)).toBe(300);
    const far = buildPresets({ points: [[0, 0, 0], [800, 0, 0]], clusters: [], launches: [] });
    expect(controlsMaxDistance(far)).toBeCloseTo(1.15 * dist(far[0]), 6);
  });
  it('framePoints widen the overview and leave the clusters alone', () => {
    const cl = [{ key: 'edge:a', label: 'FOB A', points: [[0, 0, 0], [0.1, 0, 0]] as Vec3[] }];
    const base = buildPresets({ points: pts, clusters: cl, launches: [] });
    const wide = buildPresets({ points: pts, framePoints: [[100, 0, 0]], clusters: cl, launches: [] });
    expect(dist(wide[0])).toBeGreaterThan(dist(base[0]));
    expect(wide[0].target[0]).toBeGreaterThan(base[0].target[0]);
    expect(wide[1]).toEqual(base[1]);
  });
  it('a single point still frames at a minimum distance', () => {
    const [o] = buildPresets({ points: [[1, 2, 3]], clusters: [], launches: [] });
    expect(o.target).toEqual([1, 2, 3]);
    expect(dist(o)).toBeGreaterThan(1);
  });
});

describe('launchView', () => {
  it('sits beside the launch and looks along the climb', () => {
    // climb due north (-z): side vector is (+1, 0) in x
    const v = launchView([0, 1, 0], [0, -1]);
    expect(v.target[0]).toBeCloseTo(0, 9);
    expect(v.target[1]).toBeCloseTo(1.35, 9);
    expect(v.target[2]).toBeCloseTo(-0.2, 9);
    expect(v.pos[0]).toBeCloseTo(2.0, 9);
    expect(v.pos[1]).toBeCloseTo(1.5, 9);
    expect(v.pos[2]).toBeCloseTo(0.2, 9);
  });
  it('falls back to north on a zero direction', () => {
    const v = launchView([0, 0, 0], [0, 0]);
    expect(v.target[2]).toBeCloseTo(-0.2, 9);
  });
});

describe('assetFocus', () => {
  it('targets the asset from +0.35, +0.25, +0.35', () => {
    const f = assetFocus([1, 2, 3]);
    expect(f.target).toEqual([1, 2, 3]);
    expect(f.pos[0]).toBeCloseTo(1.35, 9);
    expect(f.pos[1]).toBeCloseTo(2.25, 9);
    expect(f.pos[2]).toBeCloseTo(3.35, 9);
  });
});
