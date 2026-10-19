import { describe, expect, it } from 'vitest';
import { snapBounds, terrainBounds } from '../terrainBounds';

describe('terrainBounds', () => {
  it('is null when empty', () => {
    expect(terrainBounds([])).toBeNull();
  });
  it('pads a single point by 15 km', () => {
    const b = terrainBounds([{ lat: 52, lon: 5 }])!;
    expect(b.north - 52).toBeCloseTo(15 / 111, 9);
    expect(52 - b.south).toBeCloseTo(15 / 111, 9);
    expect(b.east - 5).toBeCloseTo(15 / (111 * Math.cos((52 * Math.PI) / 180)), 6);
    expect(5 - b.west).toBeCloseTo(b.east - 5, 9);
  });
  it('pads 20% of the span when that exceeds 15 km', () => {
    const b = terrainBounds([{ lat: 50, lon: 0 }, { lat: 54, lon: 8 }])!;
    expect(b.south).toBeCloseTo(50 - 0.8, 9);
    expect(b.north).toBeCloseTo(54 + 0.8, 9);
    expect(b.west).toBeCloseTo(-1.6, 9);
    expect(b.east).toBeCloseTo(9.6, 9);
  });
  it('uses the larger of the two paddings per axis', () => {
    const b = terrainBounds([{ lat: 50, lon: 0 }, { lat: 50.01, lon: 4 }])!;
    expect(b.north - 50.01).toBeCloseTo(15 / 111, 9); // 15 km beats 20% of 0.01 deg
    expect(0 - b.west).toBeCloseTo(0.8, 9); // 20% of 4 deg beats 15 km
  });
});

describe('snapBounds', () => {
  it('grows outward onto the grid and is stable under small moves', () => {
    const b = snapBounds({ south: 52.71, west: 4.32, north: 53.18, east: 5.07 }, 0.1);
    expect(b).toEqual({ south: 52.7, west: 4.3, north: 53.2, east: 5.1 });
    expect(snapBounds({ south: 52.72, west: 4.33, north: 53.17, east: 5.06 }, 0.1)).toEqual(b);
  });
  it('leaves a box already on the grid alone', () => {
    const b = { south: 52.7, west: 4.3, north: 53.2, east: 5.1 };
    expect(snapBounds(b, 0.1)).toEqual(b);
  });
});
