import { describe, expect, it } from 'vitest';
import { boxKey, tileBox, tileBoxBounds, viewRings, viewZoom } from '../viewTiles';
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from '../terrainTiles';

describe('tile inverses', () => {
  it('round-trip', () => {
    for (const [lat, lon, z] of [[10, 20, 5], [-33.5, 140.25, 12], [60, -100, 17]] as const) {
      expect(tileXToLon(lonToTileX(lon, z), z)).toBeCloseTo(lon, 9);
      expect(tileYToLat(latToTileY(lat, z), z)).toBeCloseTo(lat, 9);
    }
  });
});

describe('viewZoom', () => {
  it('is the zoom whose resolution matches', () => {
    // z10 at the equator is ~152.9 m/px
    expect(viewZoom(152.9, 0, 0, 22)).toBe(10);
    // at 60 deg the same z needs half the metres per pixel
    expect(viewZoom(76.4, 60, 0, 22)).toBe(10);
    expect(viewZoom(0.3, 10, 0, 22)).toBe(19);
  });
  it('clamps', () => {
    expect(viewZoom(0.001, 10, 8, 19)).toBe(19);
    expect(viewZoom(100000, 10, 8, 19)).toBe(8);
  });
});

describe('tileBox', () => {
  it('is k x k, centred on the containing tile, extra to east/south for even k', () => {
    const z = 10;
    const cx = Math.floor(lonToTileX(20, z));
    const cy = Math.floor(latToTileY(10, z));
    const odd = tileBox(10, 20, z, 5);
    expect([odd.x0, odd.x1, odd.y0, odd.y1]).toEqual([cx - 2, cx + 2, cy - 2, cy + 2]);
    const even = tileBox(10, 20, z, 6);
    expect([even.x0, even.x1, even.y0, even.y1]).toEqual([cx - 2, cx + 3, cy - 2, cy + 3]);
  });
  it('clamps at the world edge and at small z', () => {
    const e = tileBox(10, 179.99, 6, 6);
    expect(e.x1).toBe(63);
    expect(e.x0).toBe(61);
    const w = tileBox(10, -179.99, 6, 6);
    expect(w.x0).toBe(0);
    const s = tileBox(10, 20, 1, 6);
    expect([s.x0, s.x1, s.y0, s.y1]).toEqual([0, 1, 0, 1]);
  });
});

describe('viewRings', () => {
  it('steps down by two, finest first, and stops at zMin', () => {
    expect(viewRings(10, 20, 18, 11).map((b) => b.z)).toEqual([18, 16, 14]);
    expect(viewRings(10, 20, 18, 15).map((b) => b.z)).toEqual([18, 16]);
    expect(viewRings(10, 20, 18, 5, 6, 2).map((b) => b.z)).toEqual([18, 16]);
  });
  it('is empty when zFine is below zMin', () => {
    expect(viewRings(10, 20, 9, 11)).toEqual([]);
  });
});

describe('tileBoxBounds and boxKey', () => {
  it('contains the centre point and is tile aligned', () => {
    const b = tileBox(10, 20, 15, 6);
    const bd = tileBoxBounds(b);
    expect(bd.south).toBeLessThan(10);
    expect(bd.north).toBeGreaterThan(10);
    expect(bd.west).toBeLessThan(20);
    expect(bd.east).toBeGreaterThan(20);
    expect(lonToTileX(bd.west, 15)).toBeCloseTo(b.x0, 6);
    expect(latToTileY(bd.south, 15)).toBeCloseTo(b.y1 + 1, 6);
  });
  it('keys differ per box', () => {
    expect(boxKey(tileBox(10, 20, 15, 6))).not.toBe(boxKey(tileBox(10, 20.5, 15, 6)));
    expect(boxKey(tileBox(10, 20, 15, 6))).toBe(boxKey(tileBox(10, 20, 15, 6)));
  });
});
