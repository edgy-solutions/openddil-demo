// @vitest-environment jsdom
// mapMunitionTrack -- numbers, nulls and the unlabelled case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapMunitionTrack, parseTrailEcef } from '../useMunitionTracks';

const FULL = {
  munition_asset_id: 'dis:1:1:5001',
  launcher_asset_id: 'dis:1:1:42',
  event_urn: 'dis-event:1:1:7',
  munition_type: '2.1.225.1.0.0.0',
  ecef_x: '3900000.5',
  ecef_y: 300000,
  ecef_z: '5000000',
  first_seen_at: '2026-10-06T12:00:00Z',
  last_sample_at: '2026-10-06T12:00:05Z',
  last_heard_at: '2026-10-06T12:00:06Z',
  terminal_state: null,
  detonation_result: null,
  terminated_at: null,
  late_terminal: false,
  edge_id: 'edge-01',
  region_id: 'region-a',
  originator_nation: 'USA',
  releasable_to: '{USA,GBR}',
};

describe('mapMunitionTrack', () => {
  it('maps a full in-flight row, coercing numerics', () => {
    const t = mapMunitionTrack(FULL);
    expect(t).toMatchObject({
      munitionAssetId: 'dis:1:1:5001',
      launcherAssetId: 'dis:1:1:42',
      munitionType: '2.1.225.1.0.0.0',
      ecefX: 3900000.5,
      ecefY: 300000,
      ecefZ: 5000000,
      terminalState: null,
      lateTerminal: false,
      edgeId: 'edge-01',
      regionId: 'region-a',
      originatorNation: 'USA',
      releasableTo: ['USA', 'GBR'],
    });
  });

  it('keeps nulls null, never zero', () => {
    const t = mapMunitionTrack({
      munition_asset_id: 'dis:1:1:5002',
      munition_type: '2.1.225.1.0.0.0',
      ecef_x: null,
      ecef_y: undefined,
      ecef_z: '',
    });
    expect(t.launcherAssetId).toBeNull();
    expect(t.eventUrn).toBeNull();
    expect(t.ecefX).toBeNull();
    expect(t.ecefY).toBeNull();
    expect(t.ecefZ).toBeNull();
    expect(t.edgeId).toBeNull();
    expect(t.originatorNation).toBeNull();
    expect(t.releasableTo).toBeNull();
    expect(t.terminalState).toBeNull();
  });

  it('carries a terminal state when present', () => {
    const t = mapMunitionTrack({ ...FULL, terminal_state: 'silent', late_terminal: true });
    expect(t.terminalState).toBe('silent');
    expect(t.lateTerminal).toBe(true);
  });
});

describe('parseTrailEcef', () => {
  it('accepts arrays and numeric strings', () => {
    expect(parseTrailEcef([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTrailEcef(['1', '2', '3'])).toEqual([1, 2, 3]);
  });
  it('accepts a Postgres literal with exponents', () => {
    expect(parseTrailEcef('{1.5,2,-3e+06,4,5,6.25e1}')).toEqual([1.5, 2, -3e6, 4, 5, 62.5]);
  });
  it('returns null for null, empty, bad length and NaN', () => {
    expect(parseTrailEcef(null)).toBeNull();
    expect(parseTrailEcef(undefined)).toBeNull();
    expect(parseTrailEcef('{}')).toBeNull();
    expect(parseTrailEcef([])).toBeNull();
    expect(parseTrailEcef([1, 2, 3, 4])).toBeNull();
    expect(parseTrailEcef([1, 2, Number.NaN])).toBeNull();
    expect(parseTrailEcef('{1,2,NaN}')).toBeNull();
  });
  it('maps through mapMunitionTrack', () => {
    expect(mapMunitionTrack({ ...FULL, trail_ecef: '{1,2,3}' }).trailEcef).toEqual([1, 2, 3]);
    expect(mapMunitionTrack(FULL).trailEcef).toBeNull();
  });
});

describe('useMunitionTrackFeed', () => {
  const T0 = Date.parse('2026-10-31T13:45:00.000Z');
  type Res = { data: unknown[]; isLoading: boolean; isError: boolean };
  let wheres: string[];
  let rows: Res;
  async function load() {
    vi.resetModules();
    vi.doMock('../electric', () => ({
      num: (v: unknown, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f),
      parseTextArray: () => null,
      sqlLiteral: (v: string) => "'" + v.replace(/'/g, "''") + "'",
      useTableShape: (_t: string, _m: unknown, opts: { where?: string }) => {
        wheres.push(opts.where ?? '');
        return rows;
      },
    }));
    const { renderHook } = await import('@testing-library/react');
    const mod = await import('../useMunitionTracks');
    return { renderHook, ...mod };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    wheres = [];
    rows = { data: [], isLoading: false, isError: false };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../electric');
  });

  it('does not move: same where after 2 h and on a second mount', async () => {
    const { renderHook, useMunitionTrackFeed } = await load();
    const h = renderHook(() => useMunitionTrackFeed());
    const first = wheres[0];
    expect(first).toMatch(/^terminal_state IS NULL OR terminated_at > '2026-10-31T00:00:00\.000Z'::timestamptz$/);
    vi.advanceTimersByTime(2 * 3600_000);
    h.rerender();
    expect(wheres[wheres.length - 1]).toBe(first);
    h.unmount();
    renderHook(() => useMunitionTrackFeed());
    expect(wheres[wheres.length - 1]).toBe(first);
    expect(new Set(wheres).size).toBe(1);
  });

  it('floors the cut-off to the UTC day of now minus the lead', async () => {
    const { feedCutoffIso } = await load();
    expect(feedCutoffIso(Date.parse('2026-10-31T00:00:05.000Z'))).toBe('2026-10-30T00:00:00.000Z');
    expect(feedCutoffIso(Date.parse('2026-10-31T13:45:00.000Z'))).toBe('2026-10-31T00:00:00.000Z');
  });

  it('applies the display window on the client, per mount', async () => {
    const mk = (id: string, ended: number | null) =>
      mapMunitionTrack({
        ...FULL,
        munition_asset_id: id,
        terminal_state: ended === null ? null : 'DETONATED',
        terminated_at: ended === null ? null : new Date(T0 + ended).toISOString(),
      });
    rows = {
      data: [mk('flying', null), mk('old', -20_000), mk('recent', -5_000), mk('future', 60_000)],
      isLoading: false,
      isError: false,
    };
    const { renderHook, useMunitionTrackFeed } = await load();
    const h = renderHook(() => useMunitionTrackFeed());
    const ids = h.result.current.data.map((t) => t.munitionAssetId).sort();
    expect(ids).toEqual(['flying', 'future', 'recent']);
    const before = h.result.current.data;
    h.rerender();
    expect(h.result.current.data).toBe(before);
  });
});
