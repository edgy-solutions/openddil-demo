// @vitest-environment jsdom
// MovePanel -- the presentational component rendered per phase from fixture
// data (renderToStaticMarkup, as in EffectorTracksCard.test.tsx).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MovePanel, { type MemberInput, type MovePanelProps } from '../MovePanel';
import { latestEpisode, type PostureTransition } from '../../lib/movePanel';

const A = 'asset-1';
const KEY = '1.2.3.4.5.6.7';

function tr(to: string, at: string, from: string, motionSince: string | null = null): PostureTransition {
  return {
    subject: A, from, to, at, motionSince, motion: null, deploySignal: null,
    speedMps: null, edgeId: 'edge-1', regionId: null,
  };
}
const T_MARCH = tr('march_ordered', '2026-10-06T12:00:00Z', 'emplaced');
const T_MOVING = tr('moving', '2026-10-06T12:00:30Z', 'march_ordered', '2026-10-06T12:00:20Z');
const T_EMPLACING = tr('emplacing', '2026-10-06T12:10:00Z', 'moving', '2026-10-06T12:09:50Z');
const T_EMPLACED = tr('emplaced', '2026-10-06T12:10:50Z', 'emplacing');

function member(over: Partial<MemberInput> = {}, transitions: PostureTransition[] = [T_MARCH]): MemberInput {
  return {
    assetId: A,
    variant: 'LAUNCHER_X',
    declared: { label: A, asset: { [KEY]: 4 } },
    fires: [],
    resupplies: [],
    discrepancies: [],
    episode: latestEpisode(transitions, A),
    logistics: null,
    fleet: null,
    ...over,
  };
}

const STANDARDS = {
  LAUNCHER_X: {
    marchOrderS: 30,
    emplaceS: 90,
    fuelTank: { value: 500, unit: 'L' },
    fuelBurnPerKm: { value: 10, unit: 'L/km' },
  },
};

function props(over: Partial<MovePanelProps> = {}): MovePanelProps {
  return {
    kind: 'asset',
    tierKind: 'edge',
    scopeId: A,
    scopeLabel: A,
    members: [member()],
    standards: STANDARDS,
    plannedMoveKm: 20,
    nowMs: Date.parse('2026-10-06T12:00:10Z'),
    ...over,
  };
}

const html = (p: MovePanelProps) => renderToStaticMarkup(<MovePanel {...p} />);

describe('MovePanel phases', () => {
  it('no episode: one line and nothing else', () => {
    const out = html(props({ members: [member({ episode: null })] }));
    expect(out).toContain('No move on record');
    expect(out).not.toContain('move-rounds');
    expect(out).not.toContain('move-fuel');
  });

  it('march ordered: badge, c1, rounds, fuel, edge spares line, deferred, running clock', () => {
    const out = html(props({
      members: [member({
        discrepancies: [{ discrepancy_id: 'd1', fault_code: 'F1', component: 'c', severity: 'MINOR', detected_at_ns: Date.parse('2026-10-06T11:00:00Z') * 1e6 }],
      })],
    }));
    expect(out).toContain('data-testid="move-panel"');
    expect(out).toContain('data-asset="asset-1"');
    expect(out).toContain('data-phase="march_ordered"');
    expect(out).toContain('data-testid="move-c1"');
    expect(out).toContain('temporarily not operational');
    expect(out).toMatch(/data-testid="move-rounds"[^>]*data-launcher="asset-1"[^>]*data-munition="1.2.3.4.5.6.7"[^>]*data-remaining="4"/);
    expect(out).toMatch(/data-testid="move-fuel"[^>]*data-value="300"/);
    expect(out).toContain('assumes a full tank at march order');
    expect(out).toContain('Spares: the stand-in is held at HQ, not carried to this tier');
    expect(out).toMatch(/data-testid="move-deferred"[^>]*data-discrepancy="d1"/);
    expect(out).toContain('no work order on record');
    expect(out).toContain('S5000F deferred maintenance task');
    expect(out).toMatch(/data-testid="move-mo-time"[^>]*data-value="10"[^>]*data-verdict="within"/);
    expect(out).toContain('browser clock');
    expect(out).toContain('overlay-declared');
  });

  it('running march-order clock goes over the standard', () => {
    const out = html(props({ nowMs: Date.parse('2026-10-06T12:01:00Z') }));
    expect(out).toMatch(/data-testid="move-mo-time"[^>]*data-value="60"[^>]*data-verdict="over"/);
  });

  it('moving: rounds frozen at march order; a later fire does not change remaining', () => {
    const fires = [{ launchedAt: '2026-10-06T12:05:00Z', munitionType: KEY, quantity: 1 }];
    const out = html(props({
      members: [member({ fires }, [T_MARCH, T_MOVING])],
      nowMs: Date.parse('2026-10-06T12:06:00Z'),
    }));
    expect(out).toContain('data-phase="moving"');
    expect(out).toContain('as of march order');
    expect(out).toMatch(/data-testid="move-rounds"[^>]*data-remaining="4"/);
    expect(out).not.toMatch(/data-testid="move-rounds"[^>]*data-remaining="3"/);
    expect(out).toContain('moving since');
    expect(out).toMatch(/data-testid="move-mo-time"[^>]*data-value="20"[^>]*data-verdict="within"/);
  });

  it('moving: a fire before march order is in the frozen figure', () => {
    const fires = [{ launchedAt: '2026-10-06T11:00:00Z', munitionType: KEY, quantity: 1 }];
    const out = html(props({ members: [member({ fires }, [T_MARCH, T_MOVING])] }));
    expect(out).toMatch(/data-testid="move-rounds"[^>]*data-remaining="3"/);
  });

  it('moving at the edge: uplink severed and buffer depth', () => {
    const buffer = { bridge_group_lag: 42, hq_link_severed: true, probe_healthy: false, updated_at: '2026-10-06T12:05:00Z' };
    const out = html(props({ members: [member({}, [T_MARCH, T_MOVING])], buffer }));
    expect(out).toMatch(/data-testid="move-uplink"[^>]*data-severed="true"/);
    expect(out).toContain('uplink severed');
    expect(out).toMatch(/data-testid="move-buffer"[^>]*data-value="42"/);
    const up = html(props({ members: [member({}, [T_MARCH, T_MOVING])], buffer: { ...buffer, hq_link_severed: false } }));
    expect(up).toMatch(/data-severed="false"/);
    expect(up).toContain('uplink up');
  });

  it('moving at region: member reporting, last position held, link row or its absence', () => {
    const fleet = {
      reportingStatus: 'silent', reportingStatusAt: '2026-10-06T12:03:00Z',
      lastSampleAt: '2026-10-06T12:02:59Z', position: { lat: 1.234567, lon: 2.5 }, edgeId: 'edge-1',
    };
    const links = new Map([['edge-1', {
      id: 'edge-1', link_state: 'down', traffic: '', declared_idle: false,
      heartbeat_age_s: 12, last_heartbeat_at: null, bridge_lag: 7, updated_at: '2026-10-06T12:03:00Z',
    }]]);
    const p = props({ kind: 'unit', tierKind: 'region', scopeId: 'u1', scopeLabel: 'Unit 1', members: [member({ fleet }, [T_MARCH, T_MOVING])], links });
    const out = html(p);
    expect(out).toContain('data-unit="u1"');
    expect(out).toMatch(/data-testid="move-member"[^>]*data-asset="asset-1"[^>]*data-reporting="silent"/);
    expect(out).toContain('last position held');
    expect(out).toContain('1.23457');
    expect(out).toMatch(/data-testid="move-link"[^>]*data-edge="edge-1"[^>]*data-state="down"/);
    const none = html({ ...p, links: new Map() });
    expect(none).toContain('no link row for edge-1');
  });

  it('emplacing: emplace time absent until emplaced, readiness not recomputed', () => {
    const out = html(props({ members: [member({}, [T_MARCH, T_MOVING, T_EMPLACING])] }));
    expect(out).toContain('data-phase="emplacing"');
    expect(out).toMatch(/data-testid="move-emplace-time"[^>]*data-absent="not yet emplaced"/);
    expect(out).toMatch(/data-testid="move-readiness"[^>]*data-absent="not yet emplaced"/);
  });

  it('emplaced: emplace time vs standard, readiness, resupply applied, rounds as of now', () => {
    const fires = [{ launchedAt: '2026-10-06T12:05:00Z', munitionType: KEY, quantity: 2 }];
    const resupplies = [{
      receivedAt: '2026-10-06T12:08:00Z', munitionType: KEY, quantity: 1, supplierAssetId: 'sup-1',
    }];
    const out = html(props({
      members: [member({
        fires, resupplies,
        logistics: { overall_severity: 'LOGISTICS_SEVERITY_OK', computed_at: '2026-10-06T12:11:00Z' },
      }, [T_MARCH, T_MOVING, T_EMPLACING, T_EMPLACED])],
      nowMs: Date.parse('2026-10-06T12:12:00Z'),
    }));
    expect(out).toContain('data-phase="emplaced"');
    expect(out).toMatch(/data-testid="move-emplace-time"[^>]*data-value="60"[^>]*data-verdict="within"/);
    expect(out).toMatch(/data-testid="move-readiness"[^>]*data-value="LOGISTICS_SEVERITY_OK"/);
    expect(out).toContain('readiness has no location input');
    expect(out).toContain('data-testid="move-resupply"');
    expect(out).toContain('sup-1');
    expect(out).toContain('applied to the ledger');
    expect(out).toMatch(/data-testid="move-rounds"[^>]*data-remaining="3"/);
    expect(out).toContain('Due on emplacement');
  });

  it('due on emplacement lists only what was deferred at march order, not what arose during the move', () => {
    const out = html(props({
      members: [member({
        discrepancies: [
          { discrepancy_id: 'before', fault_code: 'F1', component: 'c', severity: 'MINOR', detected_at_ns: Date.parse('2026-10-06T11:00:00Z') * 1e6 },
          { discrepancy_id: 'during', fault_code: 'F2', component: 'c', severity: 'MINOR', detected_at_ns: Date.parse('2026-10-06T12:05:00Z') * 1e6 },
        ],
      }, [T_MARCH, T_MOVING, T_EMPLACING, T_EMPLACED])],
      nowMs: Date.parse('2026-10-06T12:12:00Z'),
    }));
    expect(out).toMatch(/data-testid="move-deferred"[^>]*data-discrepancy="before"/);
    expect(out).not.toContain('data-discrepancy="during"');
  });

  it('emplaced with stale readiness shows the absence', () => {
    const out = html(props({
      members: [member({
        logistics: { overall_severity: 'LOGISTICS_SEVERITY_OK', computed_at: '2026-10-06T12:00:00Z' },
      }, [T_MARCH, T_MOVING, T_EMPLACING, T_EMPLACED])],
    }));
    expect(out).toMatch(/data-testid="move-readiness"[^>]*data-absent="not recomputed since emplacement"/);
  });
});

describe('MovePanel spares', () => {
  const parts = [
    { site: 'edge-1', partRef: 'P-1', onHand: 3, leadTimeDays: null, nearestSiteWithStock: 'edge-9', nearestOnHand: 8, source: 'feed', observedAt: '2026-10-06T10:00:00Z', updatedAt: null, originatorNation: null, releasableTo: null },
    { site: 'edge-2', partRef: 'P-2', onHand: 1, leadTimeDays: 2, nearestSiteWithStock: null, nearestOnHand: null, source: null, observedAt: null, updatedAt: null, originatorNation: null, releasableTo: null },
  ];
  const fleet = { reportingStatus: 'reporting', reportingStatusAt: null, lastSampleAt: null, position: null, edgeId: 'edge-1' };

  it('hq lists the rows of the member edge, NULL as unknown', () => {
    const out = html(props({ kind: 'unit', tierKind: 'hq', members: [member({ fleet })], parts }));
    expect(out).toContain('data-testid="move-spares"');
    expect(out).toContain('P-1');
    expect(out).not.toContain('P-2');
    expect(out).toContain('unknown');
    expect(out).not.toContain('stand-in is held at HQ');
  });

  it('region shows the stand-in line, not rows', () => {
    const out = html(props({ kind: 'unit', tierKind: 'region', members: [member({ fleet })], parts }));
    expect(out).toContain('Spares: the stand-in is held at HQ, not carried to this tier');
    expect(out).not.toContain('P-1');
  });
});

describe('MovePanel absence', () => {
  it('names a missing standard', () => {
    const out = html(props({ standards: {} }));
    expect(out).toMatch(/data-testid="move-mo-time"[^>]*data-absent="no standard declared for LAUNCHER_X"/);
  });

  it('names the missing fuel inputs', () => {
    const out = html(props({ standards: { LAUNCHER_X: { marchOrderS: 30 } }, plannedMoveKm: undefined }));
    expect(out).toMatch(/data-testid="move-fuel"[^>]*data-absent="missing input: fuelTank, fuelBurnPerKm, plannedMoveKm"/);
  });

  it('absent declared load shows remaining as absent', () => {
    const out = html(props({ members: [member({
      declared: { label: A },
      fires: [{ launchedAt: '2026-10-06T11:00:00Z', munitionType: KEY, quantity: 1 }],
    })] }));
    expect(out).toMatch(/data-testid="move-rounds"[^>]*data-remaining="absent"/);
    expect(out).toContain('no declared load for asset-1');
  });
});
