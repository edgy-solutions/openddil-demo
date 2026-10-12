import { describe, expect, it } from 'vitest';
import {
  PRESETS, bwToP, formatLag, msToP, pToBw, pToMs, presetOf, sBw, sJit, sLat, toxicTags,
  toxicsToValues, valuesToToxics,
} from '../linkShaping';

describe('scale helpers', () => {
  it('latency round-trips and 0 maps to 0', () => {
    expect(msToP(0)).toBe(0);
    expect(pToMs(0)).toBe(0);
    for (const ms of [50, 300, 1200, 60000]) {
      expect(Math.abs(pToMs(msToP(ms)) - ms) / ms).toBeLessThan(0.01);
    }
  });
  it('bandwidth: far right is unlimited (0) and round-trips otherwise', () => {
    expect(bwToP(0)).toBe(1000);
    expect(pToBw(1000)).toBe(0);
    for (const b of [32, 256, 5000, 100000]) {
      expect(Math.abs(pToBw(bwToP(b)) - b) / b).toBeLessThan(0.02);
    }
  });
});

describe('severity thresholds', () => {
  it('latency', () => {
    expect([sLat(149), sLat(150), sLat(799), sLat(800)]).toEqual(['ok', 'warn', 'warn', 'bad']);
  });
  it('jitter', () => {
    expect([sJit(49), sJit(50), sJit(299), sJit(300)]).toEqual(['ok', 'warn', 'warn', 'bad']);
  });
  it('bandwidth: unlimited or >=5000 ok, >=200 warn, else bad', () => {
    expect([sBw(0), sBw(5000), sBw(4999), sBw(200), sBw(199)]).toEqual(['ok', 'ok', 'warn', 'warn', 'bad']);
  });
});

describe('presets', () => {
  it('the four presets match themselves and others are CUSTOM (-1)', () => {
    PRESETS.forEach((p, i) => expect(presetOf(p.values)).toBe(i));
    expect(presetOf({ up: true, lat: 301, jit: 80, bw: 256 })).toBe(-1);
  });
  it('severed matches whatever the shaping values are', () => {
    expect(presetOf({ up: false, lat: 300, jit: 1, bw: 5 })).toBe(3);
  });
});

describe('toxics conversion', () => {
  it('tags only the toxics that are set', () => {
    expect(toxicTags(null)).toEqual([]);
    expect(toxicTags({ latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 })).toEqual([]);
    expect(toxicTags({ latency_ms: 300, jitter_ms: 80, bandwidth_kb_s: 256 }).length).toBeGreaterThan(0);
  });
  it('refuses out-of-bounds values and sends the full state otherwise', () => {
    expect(valuesToToxics({ up: true, lat: 60001, jit: 0, bw: 0 })).toBeNull();
    expect(valuesToToxics({ up: true, lat: 0, jit: 0, bw: 1000001 })).toBeNull();
    expect(valuesToToxics({ up: true, lat: 60000, jit: 60000, bw: 1000000 })).toEqual({
      latency_ms: 60000, jitter_ms: 60000, bandwidth_kb_s: 1000000,
    });
    expect(toxicsToValues(null, true)).toEqual({ up: true, lat: 0, jit: 0, bw: 0 });
  });
});

describe('formatLag', () => {
  it('dash when the probe is down, x.xK above 1000', () => {
    expect(formatLag(true, 5)).toBe('—');
    expect(formatLag(false, 999)).toBe('999');
    expect(formatLag(false, 1000)).toBe('1000');
    expect(formatLag(false, 1500)).toBe('1.5K');
  });
});
