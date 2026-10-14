// munitionsLedger -- per-launcher and per-munition-type rollup of the effector
// ledger (effector_launch + effector_resupply) against the declared load.
//
// Pure: the caller supplies the fleet, the ledger rows and the clock. Declared
// load is the only source of "loaded"; a launcher without one stays Absent and
// is never counted as zero, so a rollup says how many launchers it left out.
import type { DeclaredLoadConfig } from '../deployment';
import {
  isAbsent,
  replayLedger,
  type Known,
  type LedgerDeclared,
  type Maybe,
} from './movePanel';

export interface LedgerLauncherInput {
  assetId: string;
  variant: string | null;
  regionId: string | null;
}
export interface LedgerLaunchInput {
  launcherAssetId: string;
  munitionType: string;
  quantity: number;
  launchedAt: string;
  terminalState: string | null;
  regionId: string | null;
}
export interface LedgerResupplyInput {
  launcherAssetId: string;
  munitionType: string;
  quantity: number;
  receivedAt: string;
  regionId: string | null;
}

export interface LauncherLedgerRow {
  launcherAssetId: string;
  variant: string | null;
  /** null = unknown region */
  regionId: string | null;
  /** DIS munition 7-tuple, as stored. */
  munitionKey: string;
  /** Declared load; Absent when undeclared. */
  loaded: Maybe<number>;
  expended: Known<number>;
  remaining: Maybe<number>;
  inFlight: Known<number>;
  unresolved: Known<number>;
  received: Known<number>;
  fired: Known<number>;
}

export interface MunitionTypeLedgerRow {
  munitionKey: string;
  launchers: number;
  undeclaredLaunchers: number;
  /** Sum over declared launchers; Absent iff every launcher is undeclared. */
  loaded: Maybe<number>;
  remaining: Maybe<number>;
  expended: number;
  inFlight: number;
  unresolved: number;
  received: number;
  fired: number;
  /** Sorted by launcherAssetId. */
  rows: LauncherLedgerRow[];
}

export interface MunitionsLedger {
  /** 'theater' or the region id. */
  scope: string;
  asOf: string;
  byType: MunitionTypeLedgerRow[];
  /** Theater scope only; regionId 'unknown' for a null region. */
  byRegion: { regionId: string; byType: MunitionTypeLedgerRow[] }[];
  launcherCount: number;
}

const UNKNOWN_REGION = 'unknown';
const TERMINAL_SOURCE = 'effector_launch terminal_state';

function ms(iso: string): number {
  return Date.parse(iso);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rollup(rows: LauncherLedgerRow[], asOf: string): MunitionTypeLedgerRow[] {
  const groups = new Map<string, LauncherLedgerRow[]>();
  for (const r of rows) {
    const g = groups.get(r.munitionKey);
    if (g) g.push(r); else groups.set(r.munitionKey, [r]);
  }
  const out: MunitionTypeLedgerRow[] = [];
  for (const key of [...groups.keys()].sort(byText)) {
    const sorted = [...groups.get(key)!].sort((a, b) => byText(a.launcherAssetId, b.launcherAssetId));
    let loaded = 0;
    let remaining = 0;
    let undeclared = 0;
    let expended = 0, inFlight = 0, unresolved = 0, received = 0, fired = 0;
    for (const r of sorted) {
      if (isAbsent(r.loaded) || isAbsent(r.remaining)) undeclared += 1;
      else { loaded += r.loaded.value; remaining += r.remaining.value; }
      expended += r.expended.value;
      inFlight += r.inFlight.value;
      unresolved += r.unresolved.value;
      received += r.received.value;
      fired += r.fired.value;
    }
    const allUndeclared = undeclared === sorted.length;
    const src = `sum of declared launchers${undeclared > 0 ? `; ${undeclared} undeclared not counted` : ''}`;
    const reason = 'no launcher of this type has a declared load';
    out.push({
      munitionKey: key,
      launchers: sorted.length,
      undeclaredLaunchers: undeclared,
      loaded: allUndeclared ? { absent: reason } : { value: loaded, source: src, at: asOf },
      remaining: allUndeclared ? { absent: reason } : { value: remaining, source: src, at: asOf },
      expended, inFlight, unresolved, received, fired,
      rows: sorted,
    });
  }
  return out;
}

export function buildMunitionsLedger(args: {
  fleet: LedgerLauncherInput[];
  launches: LedgerLaunchInput[];
  resupplies: LedgerResupplyInput[];
  declaredLoad: DeclaredLoadConfig | undefined;
  /** undefined/null = theater */
  regionId?: string | null;
  asOfMs: number;
}): MunitionsLedger {
  const { fleet, launches, resupplies, declaredLoad, asOfMs } = args;
  const theater = args.regionId == null;
  const asOf = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : '';

  // Launcher set: fleet assets with a declared load, plus every launcher the
  // ledger names. A fleet asset with neither is not a launcher.
  const fleetById = new Map(fleet.map((a) => [a.assetId, a]));
  const launchers = new Map<string, { variant: string | null; regionId: string | null }>();
  for (const a of fleet) {
    const declared =
      declaredLoad?.asset[a.assetId] !== undefined ||
      (a.variant !== null && declaredLoad?.variant[a.variant] !== undefined);
    if (declared) launchers.set(a.assetId, { variant: a.variant, regionId: a.regionId });
  }
  // A launcher with no fleet entry takes the region of its most recent ledger row.
  const latest = new Map<string, { t: number; regionId: string | null }>();
  const seen = (id: string, t: number, regionId: string | null) => {
    const prev = latest.get(id);
    if (!prev || t >= prev.t) latest.set(id, { t, regionId });
  };
  for (const l of launches) seen(l.launcherAssetId, ms(l.launchedAt), l.regionId);
  for (const r of resupplies) seen(r.launcherAssetId, ms(r.receivedAt), r.regionId);
  for (const [id, last] of latest) {
    if (launchers.has(id)) continue;
    const f = fleetById.get(id);
    launchers.set(id, f
      ? { variant: f.variant, regionId: f.regionId }
      : { variant: null, regionId: last.regionId });
  }

  const inScope = [...launchers.keys()]
    .filter((id) => theater || launchers.get(id)!.regionId === args.regionId)
    .sort(byText);

  const all: LauncherLedgerRow[] = [];
  for (const id of inScope) {
    const { variant, regionId } = launchers.get(id)!;
    const declared: LedgerDeclared = {
      label: variant ? `${id} (${variant})` : id,
      asset: declaredLoad?.asset[id],
      variant: variant ? declaredLoad?.variant[variant] : undefined,
    };
    const myLaunches = launches.filter((l) => l.launcherAssetId === id);
    const replayed = replayLedger(
      declared,
      myLaunches,
      resupplies.filter((r) => r.launcherAssetId === id),
      asOfMs,
    );
    for (const row of replayed) {
      const sum = (pick: (l: LedgerLaunchInput) => boolean): Known<number> => ({
        value: myLaunches
          .filter((l) => l.munitionType === row.munitionKey && ms(l.launchedAt) <= asOfMs && pick(l))
          .reduce((n, l) => n + l.quantity, 0),
        source: TERMINAL_SOURCE,
        at: asOf,
      });
      const fromAsset = declared.asset?.[row.munitionKey];
      const d = fromAsset ?? declared.variant?.[row.munitionKey];
      all.push({
        launcherAssetId: id,
        variant,
        regionId,
        munitionKey: row.munitionKey,
        loaded: d === undefined
          ? { absent: `no declared load for ${declared.label}` }
          : {
              value: d,
              source: fromAsset !== undefined ? 'declared asset load' : 'declared variant load',
              at: asOf,
            },
        expended: row.expended,
        remaining: row.remaining,
        inFlight: sum((l) => l.terminalState === null),
        unresolved: sum((l) => l.terminalState === 'unresolved'),
        received: row.received,
        fired: row.fired,
      });
    }
  }

  let byRegion: MunitionsLedger['byRegion'] = [];
  if (theater) {
    const groups = new Map<string, LauncherLedgerRow[]>();
    for (const r of all) {
      const k = r.regionId ?? UNKNOWN_REGION;
      const g = groups.get(k);
      if (g) g.push(r); else groups.set(k, [r]);
    }
    byRegion = [...groups.keys()].sort(byText).map((k) => ({ regionId: k, byType: rollup(groups.get(k)!, asOf) }));
  }

  return {
    scope: theater ? 'theater' : String(args.regionId),
    asOf,
    byType: rollup(all, asOf),
    byRegion,
    launcherCount: inScope.length,
  };
}
