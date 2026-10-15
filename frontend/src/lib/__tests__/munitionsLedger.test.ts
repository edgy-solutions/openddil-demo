// munitionsLedger -- launcher set, scope, replay and rollup semantics.
import { describe, expect, it } from 'vitest';
import {
  buildMunitionsLedger,
  type LedgerLaunchInput,
  type LedgerResupplyInput,
  type LedgerTrackInput,
} from '../munitionsLedger';
import { isAbsent } from '../movePanel';

const KEY = '2.1.225.1.0.0.0';
const T0 = Date.parse('2026-10-06T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const FLEET = [{ assetId: 'L1', variant: 'V', regionId: 'r1' }];
const LOAD = { asset: {}, variant: { V: { [KEY]: 5 } } };

function launch(over: Partial<LedgerLaunchInput>): LedgerLaunchInput {
  return {
    launcherAssetId: 'L1', munitionType: KEY, quantity: 1, launchedAt: at(0),
    terminalState: null, regionId: 'r1', ...over,
  };
}
const LAUNCHES: LedgerLaunchInput[] = [
  launch({ launchedAt: at(60), quantity: 2, terminalState: 'entity_impact' }),
  launch({ launchedAt: at(120), quantity: 1, terminalState: null }),
  launch({ launchedAt: at(180), quantity: 1, terminalState: 'unresolved' }),
];
const RESUPPLY: LedgerResupplyInput[] = [
  { launcherAssetId: 'L1', munitionType: KEY, quantity: 1, receivedAt: at(600), regionId: 'r1' },
];

const TRACKS: LedgerTrackInput[] = [
  { launcherAssetId: 'L1', munitionType: KEY, terminalState: null },
];

function build(over: Partial<Parameters<typeof buildMunitionsLedger>[0]> = {}) {
  return buildMunitionsLedger({
    fleet: FLEET, launches: LAUNCHES, resupplies: RESUPPLY, tracks: TRACKS, declaredLoad: LOAD,
    asOfMs: T0 + 150_000, ...over,
  });
}

function val(m: unknown): number | string {
  const x = m as { value?: number; absent?: string };
  return x.value ?? `absent:${x.absent}`;
}

describe('buildMunitionsLedger', () => {
  it('reference case at t0+150s', () => {
    const l = build();
    expect(l.scope).toBe('theater');
    expect(l.launcherCount).toBe(1);
    const t = l.byType[0];
    expect(t.munitionKey).toBe(KEY);
    const r = t.rows[0];
    expect(val(r.loaded)).toBe(5);
    expect(r.loaded).toMatchObject({ source: 'declared variant load' });
    expect(val(r.expended)).toBe(3);
    expect(val(r.remaining)).toBe(2);
    expect(val(r.inFlight)).toBe(1);
    expect(val(r.unresolved)).toBe(0);
  });

  it('reference case at t0+700s', () => {
    const r = build({ asOfMs: T0 + 700_000 }).byType[0].rows[0];
    expect(val(r.fired)).toBe(4);
    expect(val(r.received)).toBe(1);
    expect(val(r.expended)).toBe(3);
    expect(val(r.remaining)).toBe(2);
    expect(val(r.inFlight)).toBe(1);
    expect(val(r.unresolved)).toBe(1);
  });

  it('asset load wins over variant load', () => {
    const l = build({ declaredLoad: { asset: { L1: { [KEY]: 9 } }, variant: LOAD.variant } });
    expect(l.byType[0].rows[0].loaded).toMatchObject({ value: 9, source: 'declared asset load' });
  });

  it('a fleet asset with no declaration and no ledger rows is not a launcher', () => {
    const l = build({
      fleet: [...FLEET, { assetId: 'X', variant: 'W', regionId: 'r1' }],
      launches: [], resupplies: [],
    });
    expect(l.launcherCount).toBe(1);
    expect(l.byType[0].rows.map((r) => r.launcherAssetId)).toEqual(['L1']);
  });

  it('a launcher named only by the ledger is included, undeclared, region from its latest row', () => {
    const extra = [
      launch({ launcherAssetId: 'L2', launchedAt: at(10), regionId: 'r9' }),
      launch({ launcherAssetId: 'L2', launchedAt: at(20), regionId: 'r2' }),
    ];
    const l = build({ launches: [...LAUNCHES, ...extra] });
    const r2 = l.byType[0].rows.find((r) => r.launcherAssetId === 'L2')!;
    expect(r2.variant).toBeNull();
    expect(r2.regionId).toBe('r2');
    expect(isAbsent(r2.loaded)).toBe(true);
    expect(isAbsent(r2.remaining)).toBe(true);
    expect(val(r2.expended)).toBe(2);
  });

  it('theater scope carries the undeclared launcher and byRegion groups; region scope filters', () => {
    const extra = [launch({ launcherAssetId: 'L2', launchedAt: at(10), regionId: 'r2' })];
    const launches = [...LAUNCHES, ...extra];
    const theater = build({ launches });
    expect(theater.launcherCount).toBe(2);
    expect(theater.byRegion.map((g) => g.regionId)).toEqual(['r1', 'r2']);
    const r2 = theater.byRegion.find((g) => g.regionId === 'r2')!;
    expect(isAbsent(r2.byType[0].rows[0].loaded)).toBe(true);

    const scoped = build({ launches, regionId: 'r1' });
    expect(scoped.scope).toBe('r1');
    expect(scoped.byRegion).toEqual([]);
    expect(scoped.launcherCount).toBe(1);
    expect(scoped.byType[0].rows.map((r) => r.launcherAssetId)).toEqual(['L1']);
  });

  it('a null region lands in "unknown"', () => {
    const l = build({
      fleet: [{ assetId: 'L1', variant: 'V', regionId: null }],
    });
    expect(l.byRegion.map((g) => g.regionId)).toEqual(['unknown']);
  });

  it('rollup sums declared launchers only and never treats undeclared as zero', () => {
    const extra = [launch({ launcherAssetId: 'L2', launchedAt: at(10), regionId: 'r1' })];
    const t = build({ launches: [...LAUNCHES, ...extra] }).byType[0];
    expect(t.launchers).toBe(2);
    expect(t.undeclaredLaunchers).toBe(1);
    expect(t.loaded).toMatchObject({ value: 5, source: 'sum of declared launchers; 1 undeclared not counted' });
    expect(val(t.remaining)).toBe(2);
    expect(t.expended).toBe(4);
    expect(t.fired).toBe(4);
    expect(t.rows.map((r) => r.launcherAssetId)).toEqual(['L1', 'L2']);
  });

  it('rollup is Absent when every launcher is undeclared', () => {
    const l = build({
      fleet: [], declaredLoad: undefined,
      launches: [launch({ launcherAssetId: 'L2', launchedAt: at(10) })],
      resupplies: [],
    });
    const t = l.byType[0];
    expect(t.loaded).toEqual({ absent: 'no launcher of this type has a declared load' });
    expect(t.remaining).toEqual({ absent: 'no launcher of this type has a declared load' });
    expect(t.undeclaredLaunchers).toBe(1);
  });

  it('empty inputs give an empty ledger', () => {
    const l = build({ fleet: [], launches: [], resupplies: [], declaredLoad: undefined });
    expect(l.byType).toEqual([]);
    expect(l.byRegion).toEqual([]);
    expect(l.launcherCount).toBe(0);
  });

  it('types and launchers are sorted', () => {
    const l = build({
      fleet: [], declaredLoad: undefined, resupplies: [],
      launches: [
        launch({ launcherAssetId: 'B', munitionType: '9.9', regionId: 'r1' }),
        launch({ launcherAssetId: 'A', munitionType: '1.1', regionId: 'r1' }),
        launch({ launcherAssetId: 'A', munitionType: '9.9', regionId: 'r1' }),
      ],
    });
    expect(l.byType.map((t) => t.munitionKey)).toEqual(['1.1', '9.9']);
    expect(l.byType[1].rows.map((r) => r.launcherAssetId)).toEqual(['A', 'B']);
  });

  it('in flight is the non-terminal tracks per launcher and type, not effector_launch NULL rows', () => {
    const tracks: LedgerTrackInput[] = [
      { launcherAssetId: 'L1', munitionType: KEY, terminalState: null },
      { launcherAssetId: 'L1', munitionType: KEY, terminalState: null },
      { launcherAssetId: 'L1', munitionType: KEY, terminalState: 'detonated' },
      { launcherAssetId: 'L1', munitionType: '9.9.9', terminalState: null },
      { launcherAssetId: null, munitionType: KEY, terminalState: null },
    ];
    const r = build({ tracks }).byType[0].rows[0];
    expect(val(r.inFlight)).toBe(2);
    expect(r.inFlight).toMatchObject({ source: 'munition_track terminal_state IS NULL' });
    expect(val(r.expended)).toBe(3);
    expect(val(r.unresolved)).toBe(0);
    expect(val(build({ tracks: [] }).byType[0].rows[0].inFlight)).toBe(0);
  });
});
