import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMoveInputs, moveInputs, unitForAsset, __setMoveInputsForTest } from '../deployment';

const K = '1.2.3.4.5.6.7';

afterEach(() => { vi.restoreAllMocks(); __setMoveInputsForTest(undefined); });

describe('parseMoveInputs', () => {
  it('parses a good block', () => {
    const r = parseMoveInputs({
      effectors: { declaredLoad: { asset: { A1: { [K]: 4 } }, variant: { V: { [K]: 8 } } } },
      movement: {
        standards: { V: { marchOrderS: 300, emplaceS: 600, fuelTank: { value: 500, unit: 'L' }, fuelBurnPerKm: { value: 2, unit: 'L/km' } } },
        units: [{ id: 'u1', label: 'Unit 1', members: ['A1', 'A2'], plannedMoveKm: 40 }],
      },
    })!;
    expect(r.declaredLoad.asset.A1[K]).toBe(4);
    expect(r.declaredLoad.variant.V[K]).toBe(8);
    expect(r.standards.V.marchOrderS).toBe(300);
    expect(r.standards.V.fuelTank).toEqual({ value: 500, unit: 'L' });
    expect(r.units[0].plannedMoveKm).toBe(40);
  });
  it('drops malformed entries one by one, naming them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseMoveInputs({
      effectors: { declaredLoad: { asset: { A1: { [K]: 4, 'bad-key': 2, '1.1.1.1.1.1.2': -1, '1.1.1.1.1.1.3': 1.5 } }, variant: { V: 'x' } } },
      movement: {
        standards: { V: { marchOrderS: -5, emplaceS: 600 }, W: 'nope' },
        units: [{ id: 'u1', label: 'U1', members: ['A1'] }, { label: 'no id', members: [] }, { id: 'u3', label: 'L', members: 'x' }],
      },
    })!;
    expect(r.declaredLoad.asset.A1).toEqual({ [K]: 4 });
    expect(r.declaredLoad.variant).toEqual({});
    expect(r.standards.V).toEqual({ emplaceS: 600 });
    expect(r.standards.W).toBeUndefined();
    expect(r.units.map((u) => u.id)).toEqual(['u1']);
    const msgs = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msgs).toContain('bad-key');
    expect(msgs).toContain('W');
    expect(msgs).toContain('u3');
  });
  it('absent block -> undefined', () => {
    expect(parseMoveInputs({})).toBeUndefined();
    expect(parseMoveInputs(undefined)).toBeUndefined();
  });
  it('accessors', () => {
    expect(moveInputs()).toBeUndefined();
    __setMoveInputsForTest(parseMoveInputs({ movement: { units: [{ id: 'u', label: 'U', members: ['A1'] }] } }));
    expect(unitForAsset('A1')?.id).toBe('u');
    expect(unitForAsset('Z')).toBeUndefined();
  });
});
