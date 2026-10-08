import { describe, it, expect } from 'vitest';
import { ecefToWgs84, makeProjection } from '../geoProjection';

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

// Independent forward conversion (h = 0).
function wgs84ToEcef(latDeg: number, lonDeg: number) {
  const phi = (latDeg * Math.PI) / 180;
  const lam = (lonDeg * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  return {
    x: n * Math.cos(phi) * Math.cos(lam),
    y: n * Math.cos(phi) * Math.sin(lam),
    z: n * (1 - E2) * Math.sin(phi),
  };
}

describe('ecefToWgs84', () => {
  it('maps the equatorial axes', () => {
    const a = ecefToWgs84(6378137, 0, 0)!;
    expect(a.lat).toBeCloseTo(0, 9);
    expect(a.lon).toBeCloseTo(0, 9);
    const b = ecefToWgs84(0, 6378137, 0)!;
    expect(b.lat).toBeCloseTo(0, 9);
    expect(b.lon).toBeCloseTo(90, 9);
  });
  it('maps the north pole', () => {
    expect(ecefToWgs84(0, 0, 6356752.314245)!.lat).toBeCloseTo(90, 7);
  });
  it('rejects the origin and non-finite input', () => {
    expect(ecefToWgs84(0, 0, 0)).toBeNull();
    expect(ecefToWgs84(NaN, 1, 2)).toBeNull();
    expect(ecefToWgs84(1, Infinity, 2)).toBeNull();
  });
  it.each([
    [45, 10], [52.1, 5.3], [-33.9, 151.2], [12.5, -60.0], [-0.5, -179.9], [89.9, 0],
  ])('round-trips (%d, %d)', (lat, lon) => {
    const p = wgs84ToEcef(lat, lon);
    const r = ecefToWgs84(p.x, p.y, p.z)!;
    expect(Math.abs(r.lat - lat)).toBeLessThan(1e-6);
    expect(Math.abs(r.lon - lon)).toBeLessThan(1e-6);
  });
});

describe('makeProjection fallback centre', () => {
  const fob = (lat: number, lon: number) => ({ lat, lon }) as any;
  const pts = [{ lat: 10, lon: 20 }, { lat: 20, lon: 40 }];
  it('centres on the fallback mean when there are no fobs', () => {
    expect(makeProjection([], 80, pts).center).toEqual({ lat: 15, lon: 30 });
  });
  it('ignores the fallback when fobs exist', () => {
    expect(makeProjection([fob(1, 2)], 80, pts).center).toEqual({ lat: 1, lon: 2 });
  });
  it('stays at 0,0 when both are empty', () => {
    expect(makeProjection([], 80, []).center).toEqual({ lat: 0, lon: 0 });
    expect(makeProjection([], 80).center).toEqual({ lat: 0, lon: 0 });
  });
});
