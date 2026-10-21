import { describe, expect, it } from 'vitest';
import { sampleGrid } from '../terrainData';

const a = 3, b = -2;
const field = (lat: number, lon: number) => a * lat + b * lon;
const bounds = { south: 10, west: 20, north: 12, east: 24 };
const N = 21;
const grid = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  grid[j * N + i] = field(bounds.north + ((bounds.south - bounds.north) * j) / (N - 1), bounds.west + ((bounds.east - bounds.west) * i) / (N - 1));
}

describe('sampleGrid', () => {
  it('reproduces a linear field on a finer sub-box', () => {
    for (let j = 0; j <= 7; j++) for (let i = 0; i <= 7; i++) {
      const lat = 11.5 - (0.8 * j) / 7, lon = 21 + (1.7 * i) / 7;
      expect(Math.abs(sampleGrid(grid, N, bounds, lat, lon) - field(lat, lon))).toBeLessThan(1e-4);
    }
  });
  it('clamps outside the bounds to the edge values', () => {
    expect(sampleGrid(grid, N, bounds, 20, 10)).toBeCloseTo(field(12, 20), 4);
    expect(sampleGrid(grid, N, bounds, 0, 40)).toBeCloseTo(field(10, 24), 4);
  });
});
