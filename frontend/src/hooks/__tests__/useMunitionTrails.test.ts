import { describe, expect, it } from 'vitest';
import { ENDING_KIND_BY_TERMINAL_STATE, nextTrails, TRAIL_LEN, type MunitionTrailEntry } from '../useMunitionTrails';
import { BURST_MS, SILENCE_MS, type Vec3 } from '../../components/MunitionTrackHolo';

type T = { munitionAssetId: string; p: Vec3 | null; terminalState?: string | null; terminatedAt?: string | null; trailEcef?: number[] | null; ecefX?: number | null; ecefY?: number | null; ecefZ?: number | null };
// Samples arrive as ecef fields (like the real projector); the head is t.p.
const proj = (t: T) => (t.ecefX != null ? ([t.ecefX, t.ecefY ?? 0, t.ecefZ ?? 0] as Vec3) : t.p);
const tr = (id: string, p: Vec3 | null): T => ({ munitionAssetId: id, p });

function run(steps: Array<{ tracks: T[]; at: number }>): MunitionTrailEntry[] {
  let s: MunitionTrailEntry[] = [];
  for (const st of steps) s = nextTrails(s, st.tracks, proj, st.at);
  return s;
}

describe('nextTrails', () => {
  it('caps the trail at 10, oldest dropped', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({ tracks: [tr('dis:9:9:1', [i, 0, 0])], at: i }));
    const [e] = run(steps);
    expect(e.trail).toHaveLength(TRAIL_LEN);
    expect(e.trail[0]).toEqual([5, 0, 0]);
    expect(e.trail[9]).toEqual([14, 0, 0]);
  });

  it('drops a duplicate consecutive sample', () => {
    const [e] = run([
      { tracks: [tr('dis:9:9:1', [1, 2, 3])], at: 0 },
      { tracks: [tr('dis:9:9:1', [1, 2, 3 + 1e-8])], at: 1 },
      { tracks: [tr('dis:9:9:1', [4, 2, 3])], at: 2 },
    ]);
    expect(e.trail).toEqual([[1, 2, 3], [4, 2, 3]]);
  });

  it('keeps a vanished id with a silence ending until SILENCE_MS, then drops it', () => {
    const a = tr('dis:9:9:1', [1, 0, 0]);
    const s1 = run([{ tracks: [a], at: 100 }, { tracks: [], at: 200 }]);
    expect(s1).toHaveLength(1);
    expect(s1[0].ending).toEqual({ kind: 'silence', atMs: 200 });
    const s2 = nextTrails(s1, [], proj, 200 + SILENCE_MS - 1);
    expect(s2).toHaveLength(1);
    expect(s2[0].ending?.atMs).toBe(200);
    expect(nextTrails(s2, [], proj, 200 + SILENCE_MS)).toEqual([]);
  });

  it('never synthesises a detonation', () => {
    const s = run([{ tracks: [tr('dis:9:9:1', [1, 0, 0])], at: 0 }, { tracks: [], at: 10 }]);
    expect(s[0].ending?.kind).toBe('silence');
  });

  it('resumes with no ending when the id reappears before expiry', () => {
    const s = run([
      { tracks: [tr('dis:9:9:1', [1, 0, 0])], at: 0 },
      { tracks: [], at: 10 },
      { tracks: [tr('dis:9:9:1', [2, 0, 0])], at: 500 },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].ending).toBeNull();
    expect(s[0].trail).toEqual([[1, 0, 0], [2, 0, 0]]);
  });

  it('adds nothing when the projector returns null', () => {
    expect(run([{ tracks: [tr('dis:9:9:1', null)], at: 0 }])).toEqual([]);
  });

  it('returns the same array when nothing changed', () => {
    const t = [tr('dis:9:9:1', [1, 0, 0])];
    const s1 = nextTrails([], t, proj, 0);
    expect(nextTrails(s1, t, proj, 5)).toBe(s1);
  });
});

describe('endings from the ledger', () => {
  type TT = T & { terminalState?: string | null; terminatedAt?: string | null };
  const term = (id: string, state: string, at: string | null = null): TT => ({
    munitionAssetId: id, p: [1, 0, 0], terminalState: state, terminatedAt: at,
  });
  const flying = (id: string): TT => ({ munitionAssetId: id, p: [1, 0, 0] });
  const WALL = Date.parse('2026-10-16T12:00:00Z');
  const ago = (ms: number) => new Date(WALL - ms).toISOString();

  it('covers exactly the six CHECK values', () => {
    expect(Object.keys(ENDING_KIND_BY_TERMINAL_STATE).sort()).toEqual(
      ['detonated', 'dud', 'entity_impact', 'ground_impact', 'other', 'silent'],
    );
  });

  it('in flight then ground_impact: detonation at the arrival nowMs, gone after BURST_MS', () => {
    let s = nextTrails([], [flying('dis:9:9:1')], proj, 100, undefined, WALL);
    s = nextTrails(s, [term('dis:9:9:1', 'ground_impact', ago(5000))], proj, 700, undefined, WALL);
    expect(s[0].ending).toEqual({ kind: 'detonation', atMs: 700 });
    s = nextTrails(s, [term('dis:9:9:1', 'ground_impact', ago(5000))], proj, 700 + BURST_MS - 1, undefined, WALL);
    expect(s).toHaveLength(1);
    s = nextTrails(s, [term('dis:9:9:1', 'ground_impact', ago(5000))], proj, 700 + BURST_MS, undefined, WALL);
    expect(s).toEqual([]);
  });

  it('first seen terminal 0.5 s ago: detonation with 0.5 s elapsed', () => {
    const s = nextTrails([], [term('dis:9:9:1', 'entity_impact', ago(500))], proj, 10_000, undefined, WALL);
    expect(s[0].ending).toEqual({ kind: 'detonation', atMs: 9_500 });
  });

  it('first seen terminal 10 s ago: never appears', () => {
    expect(nextTrails([], [term('dis:9:9:1', 'ground_impact', ago(10_000))], proj, 10_000, undefined, WALL)).toEqual([]);
  });

  it('dud is silence, never a burst', () => {
    const s = nextTrails([], [term('dis:9:9:1', 'dud', ago(100))], proj, 10_000, undefined, WALL);
    expect(s[0].ending?.kind).toBe('silence');
  });

  it('silent is silence for SILENCE_MS', () => {
    const t = term('dis:9:9:1', 'silent', ago(0));
    let s = nextTrails([], [t], proj, 10_000, undefined, WALL);
    expect(s[0].ending).toEqual({ kind: 'silence', atMs: 10_000 });
    s = nextTrails(s, [t], proj, 10_000 + SILENCE_MS - 1, undefined, WALL + SILENCE_MS - 1);
    expect(s).toHaveLength(1);
    expect(nextTrails(s, [t], proj, 10_000 + SILENCE_MS, undefined, WALL + SILENCE_MS)).toEqual([]);
  });

  it('a row that lingers in the feed after its ending ran out does not replay (clock skew)', () => {
    const spent = new Set<string>();
    const future = term('dis:9:9:1', 'ground_impact', ago(-60_000)); // server clock ahead
    let s = nextTrails([], [future], proj, 1_000, undefined, WALL, spent);
    expect(s).toHaveLength(1);
    s = nextTrails(s, [future], proj, 1_000 + BURST_MS, undefined, WALL, spent);
    expect(s).toEqual([]);
    expect(nextTrails(s, [future], proj, 1_000 + BURST_MS + 50, undefined, WALL, spent)).toEqual([]);
  });
});

describe('nextTrails with a server trail', () => {
  const srv = (id: string, flat: number[], head: Vec3 | null): T => ({ munitionAssetId: id, p: head, trailEcef: flat });

  it('shows a 4-point trail for a first-seen track (page load)', () => {
    const [e] = run([{ tracks: [srv('dis:9:9:1', [1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0], [4, 0, 0])], at: 0 }]);
    expect(e.trail).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
  });

  it('deduplicates consecutive server samples', () => {
    const [e] = run([{ tracks: [srv('dis:9:9:1', [1, 0, 0, 1, 0, 0, 2, 0, 0], [2, 0, 0])], at: 0 }]);
    expect(e.trail).toEqual([[1, 0, 0], [2, 0, 0]]);
  });

  it('caps at 10 and ends at a differing head', () => {
    const flat = Array.from({ length: 10 }, (_, i) => [i, 0, 0]).flat();
    const [e] = run([{ tracks: [srv('dis:9:9:1', flat, [99, 0, 0])], at: 0 }]);
    expect(e.trail).toHaveLength(10);
    expect(e.trail[0]).toEqual([1, 0, 0]);
    expect(e.trail[9]).toEqual([99, 0, 0]);
  });

  it('replaces the accumulated trail when a server trail appears', () => {
    const [e] = run([
      { tracks: [tr('dis:9:9:1', [5, 0, 0])], at: 0 },
      { tracks: [tr('dis:9:9:1', [6, 0, 0])], at: 1 },
      { tracks: [srv('dis:9:9:1', [1, 0, 0, 2, 0, 0, 6, 0, 0], [6, 0, 0])], at: 2 },
    ]);
    expect(e.trail).toEqual([[1, 0, 0], [2, 0, 0], [6, 0, 0]]);
  });

  it('keeps the server trail on a terminal row', () => {
    const t: T = { ...srv('dis:9:9:1', [1, 0, 0, 2, 0, 0], [2, 0, 0]), terminalState: 'ground_impact', terminatedAt: new Date().toISOString() };
    const [e] = run([{ tracks: [t], at: 0 }]);
    expect(e.trail).toEqual([[1, 0, 0], [2, 0, 0]]);
  });
});
