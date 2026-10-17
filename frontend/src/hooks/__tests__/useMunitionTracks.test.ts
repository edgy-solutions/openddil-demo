// @vitest-environment jsdom
// mapMunitionTrack -- numbers, nulls and the unlabelled case.
import { describe, expect, it, vi } from 'vitest';
import { mapMunitionTrack } from '../useMunitionTracks';

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

describe('useMunitionTrackFeed', () => {
  it('asks for in-flight rows plus those ended since a fixed timestamptz literal', async () => {
    const calls: Array<{ where?: string }> = [];
    vi.resetModules();
    vi.doMock('../electric', () => ({
      num: (v: unknown, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f),
      parseTextArray: () => null,
      sqlLiteral: (v: string) => "'" + v.replace(/'/g, "''") + "'",
      useTableShape: (_t: string, _m: unknown, opts: { where?: string }) => {
        calls.push(opts);
        return { data: [], isLoading: false, isError: false };
      },
    }));
    const { renderHook } = await import('@testing-library/react');
    const { useMunitionTrackFeed } = await import('../useMunitionTracks');
    renderHook(() => useMunitionTrackFeed());
    expect(calls[0].where).toContain('terminal_state IS NULL OR terminated_at >');
    expect(calls[0].where).toMatch(/'\d{4}-\d{2}-\d{2}T[\d:.]+Z'::timestamptz$/);
    vi.doUnmock('../electric');
  });
});
