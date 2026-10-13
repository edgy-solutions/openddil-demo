import { describe, expect, it } from 'vitest';
import {
  latestEpisode, marchOrderTime, emplaceTime, vsStandard, replayLedger,
  fuelForMove, deferredMaintenance, readinessAfterEmplacement,
  operationalStatusConcept, resupplySince, type PostureTransition,
} from '../movePanel';
import { isPostureEvent } from '../posture';

function tr(to: string, at: string, over: Partial<PostureTransition> = {}): PostureTransition {
  return {
    subject: 'A1', from: 'unspecified', to, at, motionSince: null, motion: null,
    deploySignal: null, speedMps: null, edgeId: null, regionId: null, ...over,
  };
}

const T0 = '2026-10-01T10:00:00Z';
const T1 = '2026-10-01T10:05:00Z';
const T2 = '2026-10-01T10:20:00Z';
const T3 = '2026-10-01T10:21:00Z';
const T4 = '2026-10-01T10:30:00Z';

const full = [
  tr('emplaced', '2026-10-01T08:00:00Z'),
  tr('march_ordered', T0, { from: 'emplaced' }),
  tr('moving', T1, { from: 'march_ordered', motionSince: '2026-10-01T10:04:00Z' }),
  tr('emplacing', T3, { from: 'moving', motionSince: T2 }),
  tr('emplaced', T4, { from: 'emplacing' }),
];

describe('latestEpisode', () => {
  it('walks the full sequence', () => {
    const ep = latestEpisode(full, 'A1')!;
    expect(ep.marchOrderedAt).toBe(T0);
    expect(ep.movingAt).toBe(T1);
    expect(ep.movingMotionSince).toBe('2026-10-01T10:04:00Z');
    expect(ep.haltAt!.value).toBe(T2);
    expect(ep.haltAt!.source).toMatch(/motion_since/);
    expect(ep.emplacingAt).toBe(T3);
    expect(ep.emplacedAt).toBe(T4);
    expect(ep.phase).toBe('emplaced');
  });
  it('latest episode wins', () => {
    const second = [
      tr('march_ordered', '2026-10-02T10:00:00Z', { from: 'emplaced' }),
      tr('moving', '2026-10-02T10:01:00Z', { from: 'march_ordered', motionSince: '2026-10-02T10:00:30Z' }),
    ];
    const ep = latestEpisode([...full, ...second], 'A1')!;
    expect(ep.marchOrderedAt).toBe('2026-10-02T10:00:00Z');
    expect(ep.emplacedAt).toBeNull();
    expect(ep.phase).toBe('moving');
    expect(ep.haltAt).toBeNull();
  });
  it('still moving', () => {
    const ep = latestEpisode(full.slice(0, 3), 'A1')!;
    expect(ep.phase).toBe('moving');
    expect(ep.emplacingAt).toBeNull();
  });
  it('none on record', () => {
    expect(latestEpisode([tr('emplaced', T0)], 'A1')).toBeNull();
    expect(latestEpisode(full, 'OTHER')).toBeNull();
  });
  it('haltAt falls back to the transition time and says so', () => {
    const seq = [
      tr('march_ordered', T0), tr('moving', T1, { motionSince: T1 }),
      tr('emplacing', T3, { from: 'moving', motionSince: null }),
    ];
    const ep = latestEpisode(seq, 'A1')!;
    expect(ep.haltAt!.value).toBe(T3);
    expect(ep.haltAt!.source).toMatch(/transition time/);
  });
});

describe('timings', () => {
  it('march order time and emplace time', () => {
    const ep = latestEpisode(full, 'A1')!;
    expect(marchOrderTime(ep)).toMatchObject({ value: 240 });
    expect(emplaceTime(ep)).toMatchObject({ value: 600 });
  });
  it('absent until the phase is reached', () => {
    const ep = latestEpisode(full.slice(0, 2), 'A1')!;
    expect('absent' in marchOrderTime(ep)).toBe(true);
    expect('absent' in emplaceTime(latestEpisode(full.slice(0, 3), 'A1')!)).toBe(true);
  });
  it('vsStandard within, over, none', () => {
    expect(vsStandard(100, 120, 'V')).toMatchObject({ value: { delta: -20, verdict: 'within' } });
    expect(vsStandard(150, 120, 'V')).toMatchObject({ value: { delta: 30, verdict: 'over' } });
    expect(vsStandard(150, undefined, 'V')).toEqual({ absent: 'no standard declared for V' });
  });
});

describe('replayLedger', () => {
  const K = '1.2.3.4.5.6.7';
  const fires = [1, 2, 3, 4].map((i) => ({ launchedAt: `2026-10-01T10:0${i}:00Z`, munitionType: K, quantity: 1 }));
  const resup = [{ receivedAt: '2026-10-01T12:00:00Z', munitionType: K, quantity: 1 }];
  const declared = { label: 'A1', asset: { [K]: 5 } };
  const asOfT = Date.parse('2026-10-01T11:00:00Z');
  const now = Date.parse('2026-10-02T00:00:00Z');
  it('as-of T excludes the later resupply', () => {
    const r = replayLedger(declared, fires, resup, asOfT)[0];
    expect(r.remaining).toMatchObject({ value: 1 });
    expect(r.fired.value).toBe(4);
    expect(r.received.value).toBe(0);
  });
  it('as-of now includes it', () => {
    const r = replayLedger(declared, fires, resup, now)[0];
    expect(r.remaining).toMatchObject({ value: 2 });
    expect(r.received.value).toBe(1);
  });
  it('floors expended at zero', () => {
    const r = replayLedger(declared, fires.slice(0, 1), [
      { receivedAt: '2026-10-01T10:30:00Z', munitionType: K, quantity: 9 },
    ], now)[0];
    expect(r.expended.value).toBe(0);
    expect(r.remaining).toMatchObject({ value: 5 });
  });
  it('fire first on a tie', () => {
    const r = replayLedger(declared,
      [{ launchedAt: '2026-10-01T10:00:00Z', munitionType: K, quantity: 1 }],
      [{ receivedAt: '2026-10-01T10:00:00Z', munitionType: K, quantity: 1 }],
      now)[0];
    expect(r.expended.value).toBe(0);
  });
  it('asset entry wins over variant', () => {
    const r = replayLedger({ label: 'A1', asset: { [K]: 5 }, variant: { [K]: 9 } }, [], [], asOfT)[0];
    expect(r.remaining).toMatchObject({ value: 5 });
  });
  it('no declared load: remaining absent, counts still show', () => {
    const r = replayLedger({ label: 'A1' }, fires, resup, now)[0];
    expect(r.remaining).toEqual({ absent: 'no declared load for A1' });
    expect(r.expended.value).toBe(3);
    expect(r.received.value).toBe(1);
  });
});

describe('fuelForMove', () => {
  const std = { fuelTank: { value: 500, unit: 'L' }, fuelBurnPerKm: { value: 2, unit: 'L/km' } };
  it('full', () => {
    const r = fuelForMove(std, 100);
    expect(r.result).toMatchObject({ value: 300 });
    expect(r.assumption).toBe('assumes a full tank at march order; no fuel level is reported');
  });
  it('names each missing input', () => {
    expect(fuelForMove({ fuelBurnPerKm: std.fuelBurnPerKm }, 100).result).toEqual({ absent: expect.stringContaining('fuelTank') });
    expect(fuelForMove({ fuelTank: std.fuelTank }, 100).result).toEqual({ absent: expect.stringContaining('fuelBurnPerKm') });
    expect(fuelForMove(std, undefined).result).toEqual({ absent: expect.stringContaining('plannedMoveKm') });
    const none = fuelForMove(undefined, undefined).result as { absent: string };
    expect(none.absent).toMatch(/fuelTank.*fuelBurnPerKm.*plannedMoveKm/);
  });
  it('unit mismatch', () => {
    const r = fuelForMove({ ...std, fuelBurnPerKm: { value: 2, unit: 'gal/km' } }, 100).result;
    expect(r).toEqual({ absent: 'fuel units differ' });
  });
});

describe('deferredMaintenance', () => {
  const d = (id: string, ms: number) => ({
    discrepancy_id: id, detected_at_ns: ms * 1e6, fault_code: 'F', component: 'C',
    severity: 'MAJOR', description: 'x', recommended_action: 'y', related_ci_id: 'ci',
  });
  const T = Date.parse('2026-10-01T10:00:00Z');
  it('splits by detection time and carries no work order', () => {
    const r = deferredMaintenance([d('before', T - 1000), d('after', T + 1000)], T);
    expect(r.items.map((i) => i.discrepancyId)).toEqual(['before']);
    expect(r.items[0].workOrder).toEqual({ absent: 'no work order on record' });
    expect(r.items[0].concept).toBe('S5000F deferred maintenance task');
    expect(r.note).toBe('closure is absence: a cleared discrepancy leaves this list');
  });
});

describe('readinessAfterEmplacement', () => {
  const emp = '2026-10-01T10:30:00Z';
  it('before', () => {
    const r = readinessAfterEmplacement({ overall_severity: 'OK', computed_at: '2026-10-01T10:00:00Z' }, emp);
    expect(r.readiness).toEqual({ absent: 'not recomputed since emplacement' });
    expect(r.note).toBe('readiness has no location input');
  });
  it('after', () => {
    const r = readinessAfterEmplacement({ overall_severity: 'OK', computed_at: '2026-10-01T10:31:00Z' }, emp);
    expect(r.readiness).toMatchObject({ value: 'OK', at: '2026-10-01T10:31:00Z' });
  });
});

describe('operationalStatusConcept and resupplySince', () => {
  it('declares the ADR-0044 intent per phase, egress mapping only', () => {
    expect(operationalStatusConcept('moving')).toMatchObject({
      value: 'JC3IEDM operational status intent: temporarily not operational (weapon function); egress mapping only',
    });
    expect(operationalStatusConcept('emplaced')).toMatchObject({
      value: 'JC3IEDM operational status intent: operational (weapon function); egress mapping only, readiness decides',
    });
    expect(operationalStatusConcept('unspecified')).toEqual({ absent: 'no operational status intent for this posture' });
  });
  it('newest first, since bound', () => {
    const rows = [
      { receivedAt: '2026-10-01T10:00:00Z' }, { receivedAt: '2026-10-01T12:00:00Z' },
      { receivedAt: '2026-10-01T09:00:00Z' },
    ];
    expect(resupplySince(rows, Date.parse('2026-10-01T09:30:00Z')).map((r) => r.receivedAt))
      .toEqual(['2026-10-01T12:00:00Z', '2026-10-01T10:00:00Z']);
  });
});

describe('AlertFeed filter', () => {
  it('posture events are not feed material', () => {
    expect(isPostureEvent('openddil.posture.transition')).toBe(true);
    expect(isPostureEvent('openddil.logistics.critical')).toBe(false);
  });
});
