import { describe, expect, it } from 'vitest';
import { decodeTerrarium, fitZoom, latToTileY, lonToTileX, tileUrl } from '../terrainTiles';

describe('tile maths', () => {
  it('latToTileY(52.957, 13) is about 2670.18', () => {
    expect(latToTileY(52.957, 13)).toBeCloseTo(2670.18, 2);
  });
  it('lonToTileX maps -180..180 onto 0..2^z', () => {
    expect(lonToTileX(-180, 5)).toBe(0);
    expect(lonToTileX(0, 5)).toBe(16);
    expect(lonToTileX(180, 5)).toBe(32);
  });
  it('Terrarium (128, 0, 0) is 0 m', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 10, 128)).toBeCloseTo(10.5, 9);
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });
});

describe('fitZoom', () => {
  it('keeps the max zoom for a small area', () => {
    expect(fitZoom({ south: 52.9, west: 4.7, north: 53.0, east: 4.9 }, 11)).toBe(11);
  });
  it('drops a large region to a zoom whose mosaic fits 4096 px', () => {
    const b = { south: 50, west: 2, north: 55, east: 9 };
    const z = fitZoom(b, 11);
    expect(z).toBeLessThan(11);
    expect((lonToTileX(b.east, z) - lonToTileX(b.west, z)) * 256).toBeLessThanOrEqual(4096);
    expect((lonToTileX(b.east, z + 1) - lonToTileX(b.west, z + 1)) * 256).toBeGreaterThan(4096);
  });
});

describe('tileUrl', () => {
  it('fills z, x and y', () => {
    expect(tileUrl('https://t/{z}/{y}/{x}.png', 3, 4, 5)).toBe('https://t/3/5/4.png');
  });
});
