import { describe, expect, it } from 'vitest';
import { MAX_KINDS, SEV_RANK, fogDensity, fogVisibility, groupsOf, kindsOf, mstEdges, nextMerged, roleOf, shouldSplit } from '../clusterKinds';

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

describe('mstEdges', () => {
  const total = (e: { len: number }[]) => e.reduce((s, x) => s + x.len, 0);
  it('has n-1 edges, none for n <= 1', () => {
    expect(mstEdges([])).toEqual([]);
    expect(mstEdges([[1, 2]])).toEqual([]);
    expect(mstEdges([[0, 0], [1, 0], [2, 0], [3, 0]])).toHaveLength(3);
  });
  it('collinear points chain to the span', () => {
    expect(total(mstEdges([[0, 0], [5, 0], [1, 0], [3, 0]]))).toBeCloseTo(5);
  });
  it('a unit square costs 3', () => {
    const e = mstEdges([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(e).toHaveLength(3);
    expect(total(e)).toBeCloseTo(3);
  });
  it('duplicates give a zero-length edge', () => {
    const e = mstEdges([[4, 4], [4, 4], [9, 4]]);
    expect(e.map((x) => x.len).sort((p, q) => p - q)).toEqual([0, 5]);
  });
});

describe('nextMerged', () => {
  it('merges below 2.0, holds to 2.4, for known and unknown state', () => {
    expect(nextMerged(undefined, 1.9, 1)).toBe(true);
    expect(nextMerged(undefined, 2.1, 1)).toBe(false);
    expect(nextMerged(false, 2.1, 1)).toBe(false);
    expect(nextMerged(true, 2.1, 1)).toBe(true);
    expect(nextMerged(true, 2.5, 1)).toBe(false);
  });
  it('len 0 is always merged', () => {
    for (const w of [undefined, true, false]) expect(nextMerged(w, 0, 0.001)).toBe(true);
  });
});

describe('groupsOf', () => {
  const edges = [{ a: 0, b: 1, len: 1 }, { a: 1, b: 2, len: 1 }];
  it('all merged is one group', () => expect(groupsOf(3, edges, [true, true])).toEqual([[0, 1, 2]]));
  it('none merged is singletons', () => expect(groupsOf(3, edges, [false, false])).toEqual([[0], [1], [2]]));
  it('chain A-B merged, B-C not', () => expect(groupsOf(3, edges, [true, false])).toEqual([[0, 1], [2]]));
});

describe('two sites', () => {
  const pts: [number, number][] = [[0, 0], [0.1, 0], [0, 0.1], [10, 0], [10.1, 0], [10, 0.1]];
  const run = (p: [number, number][], r: number) => {
    const e = mstEdges(p);
    return groupsOf(p.length, e, e.map((x) => nextMerged(undefined, x.len, r)));
  };
  it('splits by place at a middling radius', () => expect(run(pts, 0.2)).toEqual([[0, 1, 2], [3, 4, 5]]));
  it('one group when far away', () => expect(run(pts, 10)).toHaveLength(1));
  it('singletons when close, duplicates stay together', () => {
    expect(run(pts, 0.01)).toHaveLength(6);
    expect(run([[0, 0], [0, 0], [3, 3]], 0.01)).toEqual([[0, 1], [2]]);
  });
});

describe('fogVisibility', () => {
  it('is 1 with no fog or no distance, falls with both', () => {
    expect(fogVisibility(0, 100)).toBe(1);
    expect(fogVisibility(0.01, 0)).toBe(1);
    expect(fogVisibility(0.01, 100)).toBeCloseTo(Math.exp(-1));
    expect(fogVisibility(0.01, 300)).toBeLessThan(fogVisibility(0.01, 100));
  });
});

describe('fogDensity', () => {
  it('keeps the target equally clear at any distance', () => {
    for (const d of [0.5, 20, 200]) {
      expect(fogVisibility(fogDensity(d, false), d)).toBeGreaterThan(0.98);
      expect(fogVisibility(fogDensity(d, false), 10 * d)).toBeLessThan(0.3);
    }
  });
  it('is lighter far out than the old fixed 0.005, and denser when selected', () => {
    expect(fogDensity(200, false)).toBeLessThan(0.005);
    expect(fogDensity(20, true)).toBeGreaterThan(fogDensity(20, false));
  });
  it('clamps', () => {
    expect(fogDensity(0, false)).toBe(0.5);
    expect(fogDensity(1e6, false)).toBe(0.0005);
  });
});
