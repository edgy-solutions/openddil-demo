// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HQ_TERRAIN_PREFS, DEFAULT_TERRAIN_PREFS, HQ_TERRAIN_PREFS_KEY, TERRAIN_PREFS_KEY,
  loadHqTerrainPrefs, loadTerrainPrefs, saveHqTerrainPrefs,
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

describe('regional terrain prefs: satBrightness', () => {
  beforeEach(() => localStorage.clear());
  const load = (v: unknown) => {
    localStorage.setItem(TERRAIN_PREFS_KEY, JSON.stringify({ satBrightness: v }));
    return loadTerrainPrefs().satBrightness;
  };

  it('defaults to 0.75', () => {
    expect(DEFAULT_TERRAIN_PREFS.satBrightness).toBe(0.75);
    expect(loadTerrainPrefs().satBrightness).toBe(0.75);
  });
  it('keeps a value in range', () => {
    expect(load(0.9)).toBe(0.9);
  });
  it('clamps to [0.4, 1.2]', () => {
    expect(load(0.1)).toBe(0.4);
    expect(load(5)).toBe(1.2);
  });
  it('falls back on non-numbers', () => {
    expect(load('1')).toBe(0.75);
    expect(load(null)).toBe(0.75);
  });
});
