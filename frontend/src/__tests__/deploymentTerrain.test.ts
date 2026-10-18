import { describe, expect, it } from 'vitest';
import { isValidDeploymentTerrain } from '../deployment';
import { DEFAULT_TERRAIN_SOURCE, elevationCredit, resolveTerrainSource } from '../lib/terrainTiles';

const T = 'https://tiles.local/{z}/{x}/{y}.png';

describe('isValidDeploymentTerrain', () => {
  it('accepts an empty block and a full one', () => {
    expect(isValidDeploymentTerrain({})).toBe(true);
    expect(isValidDeploymentTerrain({ elevationUrl: T, imageryUrl: T, attribution: 'x' })).toBe(true);
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 3, [], true]) expect(isValidDeploymentTerrain(v)).toBe(false);
  });
  it('rejects a URL that is not a z/x/y template or not a string', () => {
    expect(isValidDeploymentTerrain({ elevationUrl: 'https://t/{z}/{x}.png' })).toBe(false);
    expect(isValidDeploymentTerrain({ imageryUrl: '' })).toBe(false);
    expect(isValidDeploymentTerrain({ imageryUrl: 7 })).toBe(false);
  });
  it('rejects an empty or non-string attribution', () => {
    expect(isValidDeploymentTerrain({ attribution: '' })).toBe(false);
    expect(isValidDeploymentTerrain({ attribution: 4 })).toBe(false);
  });
});

describe('resolveTerrainSource', () => {
  it('uses the public defaults when nothing is configured', () => {
    expect(resolveTerrainSource(undefined)).toEqual(DEFAULT_TERRAIN_SOURCE);
  });
  it('overrides field by field', () => {
    const s = resolveTerrainSource({ elevationUrl: T });
    expect(s.elevationUrl).toBe(T);
    expect(s.imageryUrl).toBe(DEFAULT_TERRAIN_SOURCE.imageryUrl);
  });
});

describe('elevationCredit', () => {
  it('keeps the part after the last separator', () => {
    expect(elevationCredit(DEFAULT_TERRAIN_SOURCE.attribution)).toBe('Elevation: Terrain Tiles (AWS / Mapzen)');
    expect(elevationCredit('plain')).toBe('plain');
  });
});
