import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHq, parseTiers } from '../deployment';

describe('parseHq', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts lat/lon', () => {
    expect(parseHq({ lat: 0.5, lon: 0.5 })).toEqual({ lat: 0.5, lon: 0.5 });
  });
  it('keeps a label; drops an empty one', () => {
    expect(parseHq({ lat: 0.5, lon: 0.5, label: 'HQ Alpha' })).toEqual({ lat: 0.5, lon: 0.5, label: 'HQ Alpha' });
    expect(parseHq({ lat: 0.5, lon: 0.5, label: '' })).toEqual({ lat: 0.5, lon: 0.5 });
  });
  it('missing is undefined without a warning', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseHq(undefined)).toBeUndefined();
    expect(w).not.toHaveBeenCalled();
  });
  it.each([
    ['NaN lat', { lat: NaN, lon: 0.5 }],
    ['lon out of range', { lat: 0.5, lon: 181 }],
    ['lat out of range', { lat: -91, lon: 0.5 }],
    ['string lat', { lat: '0.5', lon: 0.5 }],
    ['partial', { lat: 0.5 }],
    ['not an object', 'HQ'],
  ])('drops %s with a warning', (_n, raw) => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseHq(raw)).toBeUndefined();
    expect(w).toHaveBeenCalledTimes(1);
  });
});

describe('parseTiers site fields', () => {
  afterEach(() => vi.restoreAllMocks());
  const base = { id: 'r1', parent: null, hasChildren: true };

  it('keeps valid lat/lon and label', () => {
    expect(parseTiers([{ ...base, lat: 10, lon: 20, label: 'Node One' }])).toEqual([
      { ...base, lat: 10, lon: 20, label: 'Node One' },
    ]);
  });
  it('drops the coords, not the entry, when invalid', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseTiers([{ ...base, lat: 91, lon: 20 }])).toEqual([base]);
    expect(parseTiers([{ ...base, lat: 10 }])).toEqual([base]);
    expect(w).toHaveBeenCalledTimes(2);
  });
  it('drops an empty or non-string label', () => {
    expect(parseTiers([{ ...base, label: '' }])).toEqual([base]);
    expect(parseTiers([{ ...base, label: 5 }])).toEqual([base]);
  });
});
