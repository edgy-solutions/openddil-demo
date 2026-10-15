// =============================================================================
// MunitionsInventory -- munitions rollup by type
// =============================================================================
// The EFFECTOR inventory dimension of the commander's air-defense picture,
// sibling to FORCE POSTURE (which handles HARDWARE readiness).
//
// PRIMARY SOURCE: the effector ledger. effector_launch + effector_resupply are
// replayed in the browser against the declared load from the deployment
// (effectors.declaredLoad); see lib/munitionsLedger.ts. Loaded is only ever a
// declared number -- a launcher with no declaration shows "undeclared", never
// zero, and the type rollup counts how many launchers it left out.
//
// SECOND SOURCE: the weapons-capability feed (useMunitionsStockpile), shown
// only when it carries entries and never merged with the ledger. Two
// witnesses are displayed side by side, not summed.
//
// SCOPING: `regionId` restricts the ledger to launchers in that region
// (undefined = theater, which also gets a by-region breakdown).
// `launcherIdFilter` restricts only the second-source block.
//
// Known operational quirks of the second source:
//   * A page reload zeroes its max-seen accumulator, so post-reload the
//     "expended" count restarts from the reload point. The Reset button
//     surfaces this explicitly so the operator understands what they're seeing.
//   * A cluster flush + fresh scenario resets the pipeline but not the
//     frontend cache. Click Reset after a flush to realign.
// =============================================================================
import { useMemo } from 'react';
import { RefreshCw, Target } from 'lucide-react';
import {
  useAllEffectorLaunches,
  useAllEffectorResupply,
  useInFlightMunitionTracks,
  useFleetAssets,
  useMunitionsStockpile,
  type MunitionTypeRollup,
} from '../../hooks';
import { moveInputs } from '../../deployment';
import { displayMunitionType } from '../../lib/munitionType';
import { usePostureClock } from '../../lib/posture';
import { isAbsent } from '../../lib/movePanel';
import {
  LedgerBadge, absentReason, numOrDash, remainingClass, valueAttrs, clockZ,
} from '../munitionsLedgerParts';
import {
  buildMunitionsLedger,
  type LauncherLedgerRow,
  type MunitionTypeLedgerRow,
  type MunitionsLedger,
} from '../../lib/munitionsLedger';

const GRID = 'grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-x-3 gap-y-1 text-[11px] font-mono';
const HEAD = 'text-[10px] text-slate-500 tracking-widest uppercase text-right';

export interface CapabilitySecondSource {
  byType: MunitionTypeRollup[];
  totals: { available: number; expended: number; initial: number };
  reset: () => void;
}

function LauncherRow({ r }: { r: LauncherLedgerRow }) {
  const undeclared = isAbsent(r.loaded);
  return (
    <div
      className="contents"
      data-testid="munitions-launcher-row"
      data-launcher={r.launcherAssetId}
      data-munition={r.munitionKey}
      data-region={r.regionId ?? 'unknown'}
      {...valueAttrs(r, {
        expended: r.expended.value,
        inFlight: r.inFlight.value,
        unresolved: r.unresolved.value,
        received: r.received.value,
      })}
    >
      <div className="text-slate-400 truncate pl-4 text-[10px]" title={r.launcherAssetId}>
        {r.launcherAssetId}{r.variant ? ` (${r.variant})` : ''}
      </div>
      <div className="text-right text-slate-600">1</div>
      <div className="text-right tabular-nums text-slate-400">
        {undeclared
          ? <span className="text-amber-400 cursor-help" title={absentReason(r.loaded)}>undeclared</span>
          : numOrDash(r.loaded)}
      </div>
      <div className="text-right tabular-nums text-slate-400">{r.expended.value}</div>
      <div className={`text-right tabular-nums ${remainingClass(r.remaining, r.loaded)}`}>
        {undeclared
          ? <span className="text-amber-400 cursor-help" title={absentReason(r.remaining)}>undeclared</span>
          : numOrDash(r.remaining)}
      </div>
      <div className="text-right tabular-nums text-slate-400">{r.inFlight.value}</div>
      <div className="text-right tabular-nums text-slate-400">{r.unresolved.value}</div>
    </div>
  );
}

function TypeRow({
  row, scope, testId, region, withLaunchers,
}: {
  row: MunitionTypeLedgerRow;
  scope: string;
  testId: string;
  region?: string;
  withLaunchers: boolean;
}) {
  return (
    <>
      <div
        className="contents"
        data-testid={testId}
        data-munition={row.munitionKey}
        data-scope={scope}
        data-region={region}
        data-launchers={row.launchers}
        data-undeclared={row.undeclaredLaunchers}
        {...valueAttrs(row, row)}
      >
        <div className="text-slate-300 truncate" title={row.munitionKey}>
          {row.munitionKey}
        </div>
        <div className="text-right tabular-nums text-slate-500">{row.launchers}</div>
        <div className="text-right tabular-nums text-slate-300">
          {numOrDash(row.loaded)}
          {row.undeclaredLaunchers > 0 && (
            <span className="text-amber-400 text-[9px] ml-1">+{row.undeclaredLaunchers} undecl.</span>
          )}
        </div>
        <div className="text-right tabular-nums text-slate-300">{row.expended}</div>
        <div className={`text-right tabular-nums ${remainingClass(row.remaining, row.loaded)}`}>
          {numOrDash(row.remaining)}
        </div>
        <div className="text-right tabular-nums text-slate-300">{row.inFlight}</div>
        <div className="text-right tabular-nums text-slate-300">{row.unresolved}</div>
      </div>
      {withLaunchers && row.rows.map((r) => (
        <LauncherRow key={`${r.launcherAssetId}|${r.munitionKey}`} r={r} />
      ))}
    </>
  );
}

function LedgerHeads() {
  return (
    <>
      <div className="text-[10px] text-slate-500 tracking-widest uppercase">TYPE</div>
      <div className={HEAD} title="Launchers">LNCH</div>
      <div className={`${HEAD} cursor-help`} title="Declared load from the deployment">LOAD</div>
      <div className={`${HEAD} cursor-help`} title="Fired minus resupplied, never below zero">EXPD</div>
      <div className={`${HEAD} cursor-help`} title="Declared load minus expended">REM</div>
      <div className={`${HEAD} cursor-help`} title="Launched, no detonation seen yet">FLT</div>
      <div className={`${HEAD} cursor-help`} title="Timed out with no detonation seen">UNRES</div>
    </>
  );
}

function SecondSource({ capability }: { capability: CapabilitySecondSource }) {
  return (
    <div className="mt-3 border border-slate-700 p-2" data-testid="munitions-second-source">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-slate-400 tracking-wider uppercase">
          Second source: weapons-capability feed (not merged with the ledger)
        </span>
        <button
          type="button"
          onClick={capability.reset}
          className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1 border border-slate-700 px-1.5 py-0.5 rounded-sm"
          title="Zero the max-seen accumulator (post-flush / new-scenario realignment)"
        >
          <RefreshCw className="w-3 h-3" />
          RESET
        </button>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 text-[11px] font-mono">
        <div className="text-[10px] text-slate-500 tracking-widest uppercase">TYPE</div>
        <div className="text-[10px] text-slate-500 tracking-widest uppercase text-right">AVAIL</div>
        {/* EXPD / INIT are derived from a running max-seen accumulator
            held in browser memory (useMunitionsStockpile) -- there is no
            durable stockpile table yet, so a page reload re-derives INIT
            from current ammo and EXPD resets to 0. The column heads have
            no room for a qualifier, so the basis rides in the tooltip
            (ADR-0017 discipline applied to a derived metric). */}
        <div
          className="text-[10px] text-slate-500 tracking-widest uppercase text-right cursor-help"
          title="Expended since this browser session started. Derived from observed ammo drops, not a durable stockpile record — a page reload resets this to 0."
        >EXPD*</div>
        <div
          className="text-[10px] text-slate-500 tracking-widest uppercase text-right cursor-help"
          title="Initial load, inferred as the maximum ammo observed for each launcher during this browser session — not a durable stockpile record."
        >INIT*</div>
        {capability.byType.map((row) => {
          // Color the available count by consumption fraction: full
          // = emerald, drained past 75% = amber, fully drained = rose.
          const drainFrac = row.initial > 0
            ? (row.initial - row.available) / row.initial
            : 0;
          const availClass = row.available === 0
            ? 'text-rose-400 font-bold'
            : drainFrac > 0.75
              ? 'text-amber-400'
              : 'text-emerald-400';
          return (
            <div key={row.munition_type} className="contents">
              <div className="text-slate-300 truncate" title={row.munition_type}>
                {displayMunitionType(row.munition_type)}
                <span className="text-slate-500 ml-2 text-[10px]">
                  ({row.launcher_count} lncher{row.launcher_count === 1 ? '' : 's'})
                </span>
              </div>
              <div className={`text-right tabular-nums ${availClass}`}>{row.available}</div>
              <div className="text-right tabular-nums text-slate-300">{row.expended}</div>
              <div className="text-right tabular-nums text-slate-500">{row.initial}</div>
            </div>
          );
        })}
        <div className="border-t border-slate-800 pt-1 mt-1 text-slate-400 tracking-widest text-[10px] uppercase">
          TOTAL
        </div>
        <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-emerald-400 font-bold">
          {capability.totals.available}
        </div>
        <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-slate-300">
          {capability.totals.expended}
        </div>
        <div className="border-t border-slate-800 pt-1 mt-1 text-right tabular-nums text-slate-500">
          {capability.totals.initial}
        </div>
      </div>
    </div>
  );
}

/** Pure view of one ledger (and, when present, the capability feed beside it). */
export function MunitionsLedgerView({
  title, ledger, loading, capability,
}: {
  title: string;
  ledger: MunitionsLedger;
  loading: boolean;
  capability: CapabilitySecondSource | null;
}) {
  const empty = ledger.byType.length === 0;
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2 flex items-center justify-between">
        <span className="flex items-center">
          <Target className="w-4 h-4 mr-2 text-amber-400" />
          {title}
          <LedgerBadge />
        </span>
      </h2>
      <div className="text-[10px] text-slate-500 mb-2" data-testid="munitions-provenance">
        Effector ledger: effector_launch + effector_resupply replayed in the browser; loaded =
        declared load from the deployment (effectors.declaredLoad); as of {clockZ(ledger.asOf)}
      </div>

      {empty ? (
        <div
          className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2"
          data-testid="munitions-empty"
          data-reason={loading ? 'loading' : 'no-launchers'}
        >
          {/* An absence with a known cause is not "awaiting" data. Once the
              ledger has loaded, an empty scope means no launcher here has a
              declared load or a recorded fire/resupply -- nothing is coming
              that would change that, so it must not read as "check back
              later". Only the loading state is a wait. */}
          {loading
            ? 'Loading effector ledger…'
            : 'No launcher in this scope has a declared load or a recorded fire/resupply'}
        </div>
      ) : (
        <>
          <div className={GRID}>
            <LedgerHeads />
            {ledger.byType.map((row) => (
              <TypeRow
                key={row.munitionKey}
                row={row}
                scope={ledger.scope}
                testId="munitions-type-row"
                withLaunchers
              />
            ))}
          </div>
          {ledger.scope === 'theater' && ledger.byRegion.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] text-slate-500 tracking-widest uppercase mb-1">By region</div>
              {ledger.byRegion.map((g) => (
                <div key={g.regionId} className="mb-2">
                  <div
                    className="text-[10px] text-slate-400 tracking-wider uppercase mb-1"
                    data-testid="munitions-region"
                    data-region={g.regionId}
                  >
                    {g.regionId}
                  </div>
                  <div className={GRID}>
                    {g.byType.map((row) => (
                      <TypeRow
                        key={row.munitionKey}
                        row={row}
                        scope={ledger.scope}
                        testId="munitions-region-type-row"
                        region={g.regionId}
                        withLaunchers={false}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {capability && <SecondSource capability={capability} />}
    </div>
  );
}

export default function MunitionsInventory({
  regionId,
  launcherIdFilter,
  title = 'Munitions Inventory (theater)',
}: {
  /** Restrict the ledger to launchers in this region. Undefined = theater. */
  regionId?: string;
  /** When set, restrict the second-source (weapons-capability) rollup to
   *  entries whose launcher_asset_id is in this Set. */
  launcherIdFilter?: ReadonlySet<string>;
  /** Panel header label -- lets a region-scoped caller override the
   *  default (theater) label. */
  title?: string;
} = {}) {
  const fleet = useFleetAssets();
  const launches = useAllEffectorLaunches();
  const resupplies = useAllEffectorResupply();
  const tracks = useInFlightMunitionTracks();
  const stockpile = useMunitionsStockpile();
  const declaredLoad = moveInputs()?.declaredLoad;
  const nowMs = usePostureClock(5000);

  const ledger = useMemo(
    () => buildMunitionsLedger({
      fleet: fleet.data.map((a) => ({
        assetId: a.asset_id,
        variant: a.platform_variant,
        regionId: a.region_id,
      })),
      launches: launches.data,
      resupplies: resupplies.data,
      tracks: tracks.data,
      declaredLoad,
      regionId,
      asOfMs: nowMs,
    }),
    [fleet.data, launches.data, resupplies.data, tracks.data, declaredLoad, regionId, nowMs],
  );

  // Second source, optionally restricted to a launcher subset: re-aggregate
  // byType and totals over just the filtered entries. Cheap -- entries are
  // typically a few dozen rows. The `reset` callback stays fleet-wide because
  // the max-seen state is shared globally.
  const view = useMemo(() => {
    if (!launcherIdFilter) {
      return { byType: stockpile.byType, totals: stockpile.totals };
    }
    const filtered = stockpile.entries.filter(
      (e) => launcherIdFilter.has(e.launcher_asset_id),
    );
    const map = new Map<string, MunitionTypeRollup>();
    for (const e of filtered) {
      let row = map.get(e.munition_type);
      if (!row) {
        row = {
          munition_type: e.munition_type,
          available: 0, expended: 0, initial: 0, launcher_count: 0,
        };
        map.set(e.munition_type, row);
      }
      row.available += e.current_ammo;
      row.expended  += e.expended;
      row.initial   += e.initial_ammo;
      row.launcher_count += 1;
    }
    const byType = Array.from(map.values()).sort(
      (a, b) => b.initial - a.initial || a.munition_type.localeCompare(b.munition_type),
    );
    let available = 0, expended = 0, initial = 0;
    for (const r of byType) {
      available += r.available; expended += r.expended; initial += r.initial;
    }
    return { byType, totals: { available, expended, initial } };
  }, [stockpile.entries, stockpile.byType, stockpile.totals, launcherIdFilter]);

  const capability = view.byType.length === 0
    ? null
    : { byType: view.byType, totals: view.totals, reset: stockpile.reset };

  return (
    <MunitionsLedgerView
      title={title}
      ledger={ledger}
      loading={fleet.isLoading || launches.isLoading || resupplies.isLoading}
      capability={capability}
    />
  );
}
