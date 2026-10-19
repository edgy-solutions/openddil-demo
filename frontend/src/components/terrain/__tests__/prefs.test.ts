// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HQ_TERRAIN_PREFS, HQ_TERRAIN_PREFS_KEY, loadHqTerrainPrefs, saveHqTerrainPrefs,
} from '../prefs';

describe('HQ terrain prefs', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to terrain on, satellite, x1', () => {
    expect(loadHqTerrainPrefs()).toEqual({ on: true, style: 'sat', exag: 1 });
    expect(HQ_TERRAIN_PREFS_KEY).toBe('openddil.hq.terrain');
  });
  it('round-trips', () => {
    saveHqTerrainPrefs({ on: false, style: 'holo', exag: 20 });
    expect(loadHqTerrainPrefs()).toEqual({ on: false, style: 'holo', exag: 20 });
  });
  it('falls back field by field on wrong types', () => {
    localStorage.setItem(HQ_TERRAIN_PREFS_KEY, JSON.stringify({ on: 'yes', style: 'holo', exag: 7 }));
    expect(loadHqTerrainPrefs()).toEqual({ ...DEFAULT_HQ_TERRAIN_PREFS, style: 'holo' });
  });
  it('falls back on junk and non-objects', () => {
    for (const raw of ['{not json', 'null', '3', '"x"']) {
      localStorage.setItem(HQ_TERRAIN_PREFS_KEY, raw);
      expect(loadHqTerrainPrefs()).toEqual(DEFAULT_HQ_TERRAIN_PREFS);
    }
  });
});
