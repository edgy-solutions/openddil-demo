import { describe, expect, it } from 'vitest';
import {
  bearingDeg, distanceKm, formatKm, framedRect, insideRect, planTopology, rectExit, resolveSites, sameSite,
  type Rect,
} from '../regionalSites';

const A = { lat: 10, lon: 20 };
// A flat made-up projection: x east, z south.
const project = (lat: number, lon: number): [number, number] => [(lon - 20) * 100, -(lat - 10) * 100];

describe('geometry', () => {
  it('distanceKm: one degree of latitude', () => {
    expect(distanceKm(A, { lat: 11, lon: 20 })).toBeCloseTo(111.2, 1);
    expect(distanceKm(A, A)).toBe(0);
  });
  it('bearingDeg: cardinal directions', () => {
    expect(bearingDeg(A, { lat: 11, lon: 20 })).toBeCloseTo(0, 6);
    expect(bearingDeg(A, { lat: 10, lon: 21 })).toBeCloseTo(90, 0);
    expect(bearingDeg(A, { lat: 9, lon: 20 })).toBeCloseTo(180, 6);
    expect(bearingDeg(A, { lat: 10, lon: 19 })).toBeCloseTo(270, 0);
  });
  it('sameSite', () => {
    expect(sameSite(A, { lat: 10.002, lon: 20 })).toBe(true);
    expect(sameSite(A, { lat: 10.1, lon: 20 })).toBe(false);
    expect(sameSite(A, { lat: 10.1, lon: 20 }, 20)).toBe(true);
  });
  it('framedRect pads and enforces a minimum', () => {
    const r = framedRect([[0, 0], [10, 20]]);
    expect(r.x0).toBeCloseTo(-1.5); expect(r.x1).toBeCloseTo(11.5);
    expect(r.z0).toBeCloseTo(-3); expect(r.z1).toBeCloseTo(23);
    expect(framedRect([[5, 5]])).toEqual({ x0: 3, z0: 3, x1: 7, z1: 7 });
  });
  const r: Rect = { x0: -10, z0: -10, x1: 10, z1: 10 };
  it('rectExit on each side and a corner', () => {
    expect(rectExit([0, 0], [20, 0], r)).toEqual([10, 0]);
    expect(rectExit([0, 0], [-20, 0], r)).toEqual([-10, 0]);
    expect(rectExit([0, 0], [0, 20], r)).toEqual([0, 10]);
    expect(rectExit([0, 0], [0, -20], r)).toEqual([0, -10]);
    expect(rectExit([0, 0], [20, 20], r)).toEqual([10, 10]);
  });
  it('rectExit is null when the target is inside', () => {
    expect(rectExit([0, 0], [5, 5], r)).toBeNull();
  });
  it('insideRect', () => {
    expect(insideRect([0, 0], r)).toBe(true);
    expect(insideRect([11, 0], r)).toBe(false);
  });
  it('formatKm', () => {
    expect(formatKm(8.44)).toBe('8.4 km');
    expect(formatKm(312.4)).toBe('312 km');
  });
});

describe('resolveSites', () => {
  it('no tiers gives nulls', () => {
    expect(resolveSites({}, 'r1')).toEqual({ regional: null, hq: null });
  });
  it('a matching row gives its site; hq comes from the deployment', () => {
    const s = resolveSites(
      { tiers: [{ id: 'r1', parent: null, hasChildren: true, lat: 10, lon: 20, label: 'Node One' }], hq: { lat: 11, lon: 21 } },
      'r1',
    );
    expect(s.regional).toEqual({ lat: 10, lon: 20, label: 'Node One' });
    expect(s.hq).toEqual({ lat: 11, lon: 21 });
  });
  it('a row without coords gives null', () => {
    expect(resolveSites({ tiers: [{ id: 'r1', parent: null, hasChildren: true }] }, 'r1').regional).toBeNull();
    expect(resolveSites({ tiers: [{ id: 'r2', parent: null, hasChildren: true, lat: 10, lon: 20 }] }, 'r1').regional).toBeNull();
  });
});

describe('planTopology', () => {
  const rect: Rect = { x0: -50, z0: -50, x1: 50, z1: 50 };
  const regional = { lat: 10, lon: 20, label: 'Node One' };
  const base = { regionId: 'r1', project, rect };

  it('puts the node at its site', () => {
    const p = planTopology({ ...base, regional: { lat: 10.1, lon: 20.2 }, hq: null });
    expect(p).toMatchObject({ kind: 'sites', regional: { x: project(10.1, 20.2)[0], z: project(10.1, 20.2)[1], label: 'R1' } });
  });
  it('off-map HQ: exit on the border, on the ray, with matching km and bearing', () => {
    const hq = { lat: 12.7, lon: 21.5 };
    const p = planTopology({ ...base, regional, hq });
    if (p.kind !== 'sites' || p.hq.mode !== 'offmap') throw new Error('expected offmap');
    const [ex, ez] = p.hq.exit;
    expect(Math.abs(Math.abs(ex) - 50) < 1e-9 || Math.abs(Math.abs(ez) - 50) < 1e-9).toBe(true);
    const [hx, hz] = project(hq.lat, hq.lon);
    const [rx, rz] = project(regional.lat, regional.lon);
    expect((ex - rx) * (hz - rz) - (ez - rz) * (hx - rx)).toBeCloseTo(0, 6);
    expect(p.hq.km).toBeCloseTo(distanceKm(regional, hq), 6);
    expect(p.hq.km).toBeGreaterThan(280);
    expect(p.hq.bearing).toBeCloseTo(bearingDeg(regional, hq), 6);
  });
  it('on-map HQ sits at its projection', () => {
    const p = planTopology({ ...base, regional, hq: { lat: 10.2, lon: 20.2 } });
    expect(p).toMatchObject({ kind: 'sites', hq: { mode: 'onmap', x: project(10.2, 20.2)[0], z: project(10.2, 20.2)[1] } });
  });
  it('colocated', () => {
    const p = planTopology({ ...base, regional, hq: { lat: 10.001, lon: 20 } });
    expect(p).toMatchObject({ kind: 'sites', hq: { mode: 'colocated' } });
  });
  it('abstract when there is no HQ site; label from the row', () => {
    const p = planTopology({ ...base, regional, hq: null });
    expect(p).toMatchObject({ kind: 'sites', regional: { label: 'Node One' }, hq: { mode: 'abstract' } });
  });
  it('fallback without a regional row, even with an HQ', () => {
    expect(planTopology({ ...base, regional: null, hq: { lat: 10, lon: 20 } })).toEqual({ kind: 'fallback' });
  });
});
