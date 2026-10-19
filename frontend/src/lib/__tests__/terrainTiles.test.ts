import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERRAIN_DEFAULTS, creditLines, decodeTerrarium, fitZoom, isRemoteUrl, latToTileY, lonToTileX, resolveTerrainSource, tileUrl,
} from '../terrainTiles';

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

describe('resolveTerrainSource', () => {
  const T = 'https://tiles.example/{z}/{x}/{y}.png';
  afterEach(() => vi.restoreAllMocks());

  it('defaults to relief, network off, local URLs and no imagery', () => {
    const s = resolveTerrainSource(undefined);
    expect(s.basemap).toBe('relief');
    expect(s.network).toBe(false);
    for (const u of [s.elevationUrl, s.landUrl, s.lakesUrl, s.waterUrl]) expect(isRemoteUrl(u)).toBe(false);
    expect(s.elevationUrl).toBe('/deployment-overlay/terrain/dem/{z}/{x}/{y}.png');
    expect(s.imageryUrl).toBe('');
    expect(s.patchImageryUrl).toBe('');
    expect(s.reliefPalette).toBe('sand');
  });
  it('names no licensed vendor in the defaults', () => {
    expect(JSON.stringify(TERRAIN_DEFAULTS).toLowerCase()).not.toMatch(new RegExp(['arc' + 'gis', 'es' + 'ri'].join('|')));
  });
  it('refuses a remote URL without network, falling back and warning once per field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = resolveTerrainSource({ waterUrl: 'https://w.example/water.json' });
    const b = resolveTerrainSource({ waterUrl: '//w.example/water.json' });
    expect(a.waterUrl).toBe(TERRAIN_DEFAULTS.waterUrl);
    expect(b.waterUrl).toBe(TERRAIN_DEFAULTS.waterUrl);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('waterUrl'))).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).toContain('network is off');
  });
  it('allows a remote URL with network on', () => {
    const s = resolveTerrainSource({ network: true, elevationUrl: T });
    expect(s.elevationUrl).toBe(T);
    expect(s.network).toBe(true);
  });
  it('lays a local URL over the default', () => {
    expect(resolveTerrainSource({ elevationUrl: '/dem/{z}/{x}/{y}.png' }).elevationUrl).toBe('/dem/{z}/{x}/{y}.png');
  });
  it('applies per-basemap defaults', () => {
    const im = resolveTerrainSource({ basemap: 'imagery' });
    expect(im.imageryMaxZoom).toBe(14);
    expect(im.patchImageryUrl).toBe('');
    expect(im.imageryUrl).toBe('/deployment-overlay/terrain/imagery/{z}/{x}/{y}.jpg');
    expect(im.credits.imagery).toContain('Sentinel-2 cloudless 2016');
    const li = resolveTerrainSource({ basemap: 'licensed', network: true, imageryUrl: T });
    expect(li.imageryMaxZoom).toBe(19);
    expect(li.patchImageryUrl).toBe(T);
    expect(li.credits.imagery).toBe('Imagery: deployment-supplied source');
    expect(resolveTerrainSource({ basemap: 'imagery', imageryMaxZoom: 12 }).imageryMaxZoom).toBe(12);
  });
  it('clears the imagery URLs for relief', () => {
    const s = resolveTerrainSource({ basemap: 'relief', imageryUrl: '/i/{z}/{x}/{y}.jpg', patchImageryUrl: '/p/{z}/{x}/{y}.jpg' });
    expect(s.imageryUrl).toBe('');
    expect(s.patchImageryUrl).toBe('');
  });
  it('lets config credits override per key', () => {
    const s = resolveTerrainSource({ credits: { land: 'Land: x' } });
    expect(s.credits.land).toBe('Land: x');
    expect(s.credits.elevation).toBe(TERRAIN_DEFAULTS.credits.elevation);
  });
});

describe('creditLines', () => {
  const none = { style: 'holo', landMask: false, water: false } as const;
  it('is the elevation credit alone on holo with no masks', () => {
    expect(creditLines(resolveTerrainSource(undefined), none)).toEqual([TERRAIN_DEFAULTS.credits.elevation]);
  });
  it('adds the coast and water credits for relief with masks', () => {
    expect(creditLines(resolveTerrainSource(undefined), { style: 'sat', landMask: true, water: true })).toEqual([
      TERRAIN_DEFAULTS.credits.elevation, TERRAIN_DEFAULTS.credits.land, TERRAIN_DEFAULTS.credits.water,
    ]);
  });
  it('adds the imagery and patch credits for imagery on the sat style only', () => {
    const s = resolveTerrainSource({ basemap: 'imagery', patchImageryUrl: '/p/{z}/{x}/{y}.jpg', credits: { patchImagery: 'Aerial: national survey' } });
    const lines = creditLines(s, { style: 'sat', landMask: false, water: false });
    expect(lines).toEqual([s.credits.elevation, s.credits.imagery, 'Aerial: national survey']);
    expect(creditLines(s, none)).toEqual([s.credits.elevation]);
  });
  it('shows the default licensed credit', () => {
    const s = resolveTerrainSource({ basemap: 'licensed', network: true, imageryUrl: 'https://t.example/{z}/{x}/{y}.jpg' });
    expect(creditLines(s, { style: 'sat', landMask: false, water: false })).toContain('Imagery: deployment-supplied source');
  });
  it('drops duplicates', () => {
    const s = resolveTerrainSource({ credits: { land: 'Elevation: Terrain Tiles (AWS / Mapzen)' } });
    expect(creditLines(s, { style: 'holo', landMask: true, water: false })).toEqual([s.credits.elevation]);
  });
});
