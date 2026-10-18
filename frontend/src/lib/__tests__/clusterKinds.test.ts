import { describe, expect, it } from 'vitest';
import { MAX_KINDS, SEV_RANK, kindsOf, roleOf, shouldSplit } from '../clusterKinds';

const OK = 'LOGISTICS_SEVERITY_OK';
const DEG = 'LOGISTICS_SEVERITY_DEGRADED';
const CRIT = 'LOGISTICS_SEVERITY_CRITICAL';
const m = (variant: string | null, severity = OK) => ({ variant, severity });

describe('roleOf', () => {
  it('ranks shooters, sensors, command, other, none', () => {
    expect([roleOf('MRAD2_launcher'), roleOf('M1A2-SEPv3'), roleOf('X_radar'), roleOf('HEADQUARTER_COMPLEX'), roleOf('FOO'), roleOf(null)])
      .toEqual([0, 0, 1, 2, 3, 4]);
  });
});

describe('kindsOf', () => {
  it('groups by variant and orders shooters, sensors, command, other', () => {
    const { shown, hidden } = kindsOf([m('HEADQUARTER_COMPLEX'), m('A_radar'), m('B_launcher'), m('A_launcher'), m('A_launcher')]);
    expect(hidden).toEqual([]);
    expect(shown.map((k) => k.variant)).toEqual(['A_launcher', 'B_launcher', 'A_radar', 'HEADQUARTER_COMPLEX']);
    expect(shown[0].members).toHaveLength(2);
  });
  it('breaks ties on count then name', () => {
    const { shown } = kindsOf([m('B_launcher'), m('A_launcher'), m('B_launcher'), m('C_launcher')]);
    expect(shown.map((k) => k.variant)).toEqual(['B_launcher', 'A_launcher', 'C_launcher']);
  });
  it('shows at most MAX_KINDS; past that, MAX_KINDS-1 plus a hidden list', () => {
    const { shown, hidden } = kindsOf([m('A_launcher'), m('B_launcher'), m('C_launcher'), m('D_launcher'), m('E_launcher')]);
    expect(shown).toHaveLength(MAX_KINDS - 1);
    expect(hidden).toHaveLength(2);
    expect(shown.map((k) => k.variant)).toEqual(['A_launcher', 'B_launcher', 'C_launcher']);
  });
  it('exactly MAX_KINDS kinds are all shown', () => {
    const { shown, hidden } = kindsOf([m('A_launcher'), m('B_launcher'), m('C_launcher'), m('D_launcher')]);
    expect(shown).toHaveLength(4);
    expect(hidden).toHaveLength(0);
  });
  it('never hides a faulted kind', () => {
    const { shown, hidden } = kindsOf([
      m('A_launcher'), m('B_launcher'), m('C_launcher'), m('D_launcher'), m('Z_radar', CRIT), m('Y_radar', DEG),
    ]);
    const names = shown.map((k) => k.variant);
    expect(names).toContain('Z_radar');
    expect(names).toContain('Y_radar');
    expect(hidden.every((k) => (SEV_RANK[k.sev] ?? 0) === 0)).toBe(true);
  });
  it("a kind's severity is its worst member's", () => {
    const { shown } = kindsOf([m('A_launcher'), m('A_launcher', CRIT), m('A_launcher', DEG)]);
    expect(shown[0].sev).toBe(CRIT);
    expect(shown[0].members).toHaveLength(3);
  });
});

describe('shouldSplit hysteresis', () => {
  it('clustered: splits only at 2.4 symbol radii', () => {
    expect(shouldSplit(true, 2.3, 1)).toBe(false);
    expect(shouldSplit(true, 2.5, 1)).toBe(true);
  });
  it('split: re-clusters only below 2.0 symbol radii', () => {
    expect(shouldSplit(false, 2.1, 1)).toBe(true);
    expect(shouldSplit(false, 1.9, 1)).toBe(false);
  });
  it('between 2.0 and 2.4 keeps whichever state it is in', () => {
    expect(shouldSplit(true, 2.2, 1)).toBe(false);
    expect(shouldSplit(false, 2.2, 1)).toBe(true);
  });
  it('members at one coordinate never split', () => {
    expect(shouldSplit(true, 0, 1e-9)).toBe(false);
    expect(shouldSplit(false, 0, 1e-9)).toBe(false);
  });
});
