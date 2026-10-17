import { describe, expect, it } from 'vitest';
import { nextTrails, TRAIL_LEN, type MunitionTrailEntry } from '../useMunitionTrails';
import { SILENCE_MS, type Vec3 } from '../../components/MunitionTrackHolo';

type T = { munitionAssetId: string; p: Vec3 | null };
const proj = (t: T) => t.p;
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
