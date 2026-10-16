import { describe, expect, it } from 'vitest';
import {
  nationStyle, nationsInFleet, parseNationRegistry, UNLABELLED,
  type NationRegistryEntry,
} from '../lib/nationColor';

// Synthetic registry, in the order the gateway serves it (file order).
const REG: NationRegistryEntry[] = [
  { code: 'BDR', name: 'Borduria', color: '#a78bfa' },
  { code: 'ATL', name: 'Atlantia', color: '#38bdf8' },
  { code: 'NOC', name: 'Nocolour', color: null },
];

describe('nationColor', () => {
  it('builds the style from the registry hex', () => {
    const n = nationStyle('ATL', REG);
    expect(n.label).toBe('Atlantia');
    expect(n.hex).toBe('#38bdf8');
    expect(n.chipStyle).toEqual({
      backgroundColor: '#38bdf826', color: '#38bdf8', borderColor: '#38bdf866',
    });
    expect(n.dotStyle).toEqual({ backgroundColor: '#38bdf8' });
  });
  it('has no built-in palette: an empty registry means unknown', () => {
    expect(nationStyle('ATL').label).toContain('no palette entry');
  });
  it('treats a code absent from the registry, or without a colour, as unknown', () => {
    for (const code of ['ZZZ', 'NOC']) {
      const n = nationStyle(code, REG);
      expect(n.label).toBe(`${code} (no palette entry)`);
      expect(n.chipStyle).toBeUndefined();
    }
  });
  it('keeps unlabelled as its own fixed state', () => {
    expect(nationStyle(null, REG)).toBe(UNLABELLED);
    expect(nationStyle('', REG)).toBe(UNLABELLED);
  });
  it('orders the legend by registry order, then unknowns, then unlabelled', () => {
    const fleet = [
      { originator_nation: 'ATL' }, { originator_nation: 'ZZZ' },
      { originator_nation: null }, { originator_nation: 'BDR' },
    ];
    expect(nationsInFleet(fleet, REG).map((n) => n.code)).toEqual(['BDR', 'ATL', 'ZZZ', '—']);
  });
  it('drops malformed wire entries and bad colours', () => {
    expect(parseNationRegistry(undefined)).toEqual([]);
    expect(parseNationRegistry([
      { code: 'ATL', name: 'Atlantia', color: '#38bdf8' },
      { code: 'BDR', color: 'red' },
      { name: 'no code' },
      null,
    ])).toEqual([
      { code: 'ATL', name: 'Atlantia', color: '#38bdf8' },
      { code: 'BDR', name: 'BDR', color: null },
    ]);
  });
});
