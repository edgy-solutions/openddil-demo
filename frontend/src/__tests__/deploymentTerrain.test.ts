import { describe, expect, it } from 'vitest';
import { isValidDeploymentTerrain } from '../deployment';

const T = 'https://tiles.local/{z}/{x}/{y}.png';

describe('isValidDeploymentTerrain', () => {
  it('accepts an empty block and a full one', () => {
    expect(isValidDeploymentTerrain({})).toBe(true);
    expect(isValidDeploymentTerrain({
      basemap: 'licensed', network: true, elevationUrl: T, imageryUrl: T, patchImageryUrl: T,
      imageryMaxZoom: 19, patchMaxZoom: 0, landUrl: 'https://land.local/land.json', lakesUrl: '/l.json', waterUrl: '/w.json',
      reliefPalette: 'slate', credits: { elevation: 'a', imagery: 'b', patchImagery: 'c', land: 'd', water: 'e', other: 7 },
    })).toBe(true);
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 3, [], true]) expect(isValidDeploymentTerrain(v)).toBe(false);
  });
  it('rejects a URL that is not a z/x/y template or not a string', () => {
    expect(isValidDeploymentTerrain({ elevationUrl: 'https://t/{z}/{x}.png' })).toBe(false);
    expect(isValidDeploymentTerrain({ imageryUrl: '' })).toBe(false);
    expect(isValidDeploymentTerrain({ patchImageryUrl: 'https://t/p.png' })).toBe(false);
    expect(isValidDeploymentTerrain({ imageryUrl: 7 })).toBe(false);
  });
  it('rejects a bad basemap, palette or network flag', () => {
    expect(isValidDeploymentTerrain({ basemap: 'satellite' })).toBe(false);
    expect(isValidDeploymentTerrain({ basemap: 7 })).toBe(false);
    expect(isValidDeploymentTerrain({ reliefPalette: 'neon' })).toBe(false);
    expect(isValidDeploymentTerrain({ network: 'true' })).toBe(false);
    expect(isValidDeploymentTerrain({ network: 1 })).toBe(false);
  });
  it('rejects a zoom that is not an integer in 0..22', () => {
    for (const z of [-1, 23, 1.5, '14', NaN]) {
      expect(isValidDeploymentTerrain({ imageryMaxZoom: z })).toBe(false);
      expect(isValidDeploymentTerrain({ patchMaxZoom: z })).toBe(false);
    }
  });
  it('rejects an empty credit, a non-string credit or non-object credits, whole', () => {
    expect(isValidDeploymentTerrain({ credits: { imagery: '' } })).toBe(false);
    expect(isValidDeploymentTerrain({ credits: { land: 4 } })).toBe(false);
    expect(isValidDeploymentTerrain({ credits: 'x' })).toBe(false);
    expect(isValidDeploymentTerrain({ credits: [] })).toBe(false);
    expect(isValidDeploymentTerrain({ basemap: 'imagery', credits: { water: '' } })).toBe(false);
  });
  it('accepts land, lakes and water URLs that are non-empty strings, or absent', () => {
    for (const k of ['landUrl', 'lakesUrl', 'waterUrl']) {
      expect(isValidDeploymentTerrain({ [k]: '/deployment-overlay/x.json' })).toBe(true);
      expect(isValidDeploymentTerrain({ [k]: '' })).toBe(false);
      expect(isValidDeploymentTerrain({ [k]: 9 })).toBe(false);
    }
  });
  it('no longer knows attribution: it is ignored like any unknown key', () => {
    expect(isValidDeploymentTerrain({ attribution: '' })).toBe(true);
    expect(isValidDeploymentTerrain({ attribution: 4 })).toBe(true);
  });
});
