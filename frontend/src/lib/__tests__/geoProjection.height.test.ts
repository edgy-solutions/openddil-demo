import { describe, expect, it } from 'vitest';
import { ecefToWgs84 } from '../geoProjection';

const A = 6378137;
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

// Independent forward conversion, with height.
function toEcef(latDeg: number, lonDeg: number, h: number) {
  const phi = (latDeg * Math.PI) / 180;
  const lam = (lonDeg * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  return {
    x: (n + h) * Math.cos(phi) * Math.cos(lam),
    y: (n + h) * Math.cos(phi) * Math.sin(lam),
    z: (n * (1 - E2) + h) * Math.sin(phi),
  };
}

describe('ecefToWgs84 height', () => {
  it('reads 10 km up at (0, 0)', () => {
    const r = ecefToWgs84(A + 10000, 0, 0)!;
    expect(r.h).toBeCloseTo(10000, 2);
    expect(r.lat).toBeCloseTo(0, 9);
    expect(r.lon).toBeCloseTo(0, 9);
  });

  it('round-trips height at 60 N, 10 km up', () => {
    const { x, y, z } = toEcef(60, 10, 10000);
    const r = ecefToWgs84(x, y, z)!;
    expect(Math.abs(r.h - 10000)).toBeLessThan(0.01);
    expect(r.lat).toBeCloseTo(60, 9);
    expect(r.lon).toBeCloseTo(10, 9);
  });

  it('round-trips on the low-latitude branch too', () => {
    const { x, y, z } = toEcef(20, -70, 3000);
    const r = ecefToWgs84(x, y, z)!;
    expect(Math.abs(r.h - 3000)).toBeLessThan(0.01);
  });

  it('leaves lat/lon unchanged for a surface point', () => {
    const { x, y, z } = toEcef(45, 100, 0);
    const r = ecefToWgs84(x, y, z)!;
    expect(r.lat).toBeCloseTo(45, 9);
    expect(r.lon).toBeCloseTo(100, 9);
    expect(Math.abs(r.h)).toBeLessThan(0.01);
  });

  it('still returns null for non-finite input', () => {
    expect(ecefToWgs84(NaN, 0, 0)).toBeNull();
  });
});
