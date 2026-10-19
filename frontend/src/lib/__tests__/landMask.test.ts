import { describe, expect, it } from 'vitest';
import { decodeLand, drawMask, mercatorV, type Ring, type Topology } from '../landMask';

// Scale 1, translate (10, 20). Arc 0: (10,20) (12,20) (12,22). Arc 1: (12,22) (10,22) (10,20).
// Arc 2 stands alone at (15,25).
const topo = (objects: Topology['objects']): Topology => ({
  transform: { scale: [1, 1], translate: [10, 20] },
  arcs: [
    [[0, 0], [2, 0], [0, 2]],
    [[2, 2], [-2, 0], [0, -2]],
    [[5, 5], [1, 0], [0, 1], [-1, 0]],
  ],
  objects,
});

describe('decodeLand', () => {
  it('delta-decodes arcs and applies the transform', () => {
    const rings = decodeLand(topo({ land: { type: 'Polygon', arcs: [[0, 1]] } }));
    expect(rings).toEqual([[[10, 20], [12, 20], [12, 22], [10, 22], [10, 20]]]);
  });

  it('applies the scale', () => {
    const t = topo({ land: { type: 'Polygon', arcs: [[0]] } });
    t.transform.scale = [0.5, 2];
    expect(decodeLand(t)[0]).toEqual([[10, 20], [11, 20], [11, 24]]);
  });

  it('runs a reversed arc (~i) backwards', () => {
    const rings = decodeLand(topo({ land: { type: 'Polygon', arcs: [[~1, ~0]] } }));
    expect(rings).toEqual([[[10, 20], [10, 22], [12, 22], [12, 20], [10, 20]]]);
  });

  it('reads every polygon of a MultiPolygon, inside a collection', () => {
    const rings = decodeLand(topo({
      land: { type: 'GeometryCollection', geometries: [
        { type: 'MultiPolygon', arcs: [[[0, 1]], [[2]]] },
      ] },
    }));
    expect(rings).toHaveLength(2);
    expect(rings[1][0]).toEqual([15, 25]);
  });
});

describe('mercatorV', () => {
  const b = { south: 40, north: 60, west: 0, east: 10 };
  it('is 1 at the north edge and 0 at the south', () => {
    expect(mercatorV(60, b)).toBeCloseTo(1, 12);
    expect(mercatorV(40, b)).toBeCloseTo(0, 12);
  });
  it('is 0.5 at the mercator midpoint, which is poleward of the middle latitude', () => {
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const mid = (2 * Math.atan(Math.exp((y(40) + y(60)) / 2)) - Math.PI / 2) * (180 / Math.PI);
    expect(mid).toBeGreaterThan(50);
    expect(mercatorV(mid, b)).toBeCloseTo(0.5, 9);
    expect(mercatorV(50, b)).toBeLessThan(0.5);
  });
});

describe('drawMask', () => {
  const b = { south: 40, north: 60, west: 0, east: 10 };
  const square = (lon: number, lat: number): Ring => [[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1]];
  const fake = () => {
    const log = { fills: [] as { style: string; rule: unknown; points: number }[], points: 0 };
    let style = '';
    const ctx = {
      set fillStyle(v: string) { style = v; },
      get fillStyle() { return style; },
      filter: '',
      fillRect: () => {},
      beginPath: () => { log.points = 0; },
      moveTo: () => { log.points++; },
      lineTo: () => { log.points++; },
      closePath: () => {},
      fill: (rule: unknown) => { log.fills.push({ style, rule, points: log.points }); },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
  };

  it('fills land white, then lakes black', () => {
    const { ctx, log } = fake();
    drawMask(ctx, b, 100, 100, [square(2, 45)], [square(3, 46)]);
    expect(log.fills.map((f) => f.style)).toEqual(['#fff', '#000']);
    expect(log.fills.every((f) => f.rule === 'evenodd')).toBe(true);
    expect(log.fills[1].points).toBe(4);
  });

  it('draws no points for a lake outside the bounds', () => {
    const { ctx, log } = fake();
    drawMask(ctx, b, 100, 100, [square(2, 45)], [square(50, 10)]);
    expect(log.fills.map((f) => f.style)).toEqual(['#fff', '#000']);
    expect(log.fills[1].points).toBe(0);
  });

  it('with no lakes there is only one fill', () => {
    const { ctx, log } = fake();
    drawMask(ctx, b, 100, 100, [square(2, 45)], []);
    expect(log.fills).toHaveLength(1);
    expect(log.fills[0].style).toBe('#fff');
  });
});
