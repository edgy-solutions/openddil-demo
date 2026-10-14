// =============================================================================
// MunitionsLoadoutCard -- per-launcher munitions loadout
// =============================================================================
// Renders ONLY when the selected asset is a LAUNCHER (asset_class ===
// 'LAUNCHER'). Sensor / facility / platform / munition selections get nothing.
//
// PRIMARY SOURCE: the effector ledger, filtered to the selected launcher. The
// same code as the inventory card builds it (lib/munitionsLedger.ts):
// effector_launch + effector_resupply are replayed in the browser against the
// declared load from the deployment (effectors.declaredLoad). Loaded is only
// ever a declared number -- a launcher with no declaration shows "undeclared",
// never zero. In flight comes only from the ledger.
//
// SECOND SOURCE: the weapons-capability feed (useMunitionsStockpile), shown
// as a compact block only when it carries entries for this launcher. It is
// never merged with, or substituted for, the ledger numbers.
//
// Data sources:
//   * useClassifiedFleet                       -- render-or-hide gate
//   * useFleetAssets / useAllEffectorLaunches /
//     useAllEffectorResupply / declaredLoad    -- the ledger
//   * useMunitionsStockpile                    -- second source
// =============================================================================
import { useMemo } from 'react';
import { Target, Package } from 'lucide-react';
import {
  useAllEffectorLaunches,
  useAllEffectorResupply,
  useClassifiedFleet,
  useFleetAssets,
  useMunitionsStockpile,
  stockpileForLauncher,
} from '../hooks';
import { moveInputs } from '../deployment';
import { displayMunitionType } from '../lib/munitionType';
import { usePostureClock } from '../lib/posture';
import { isAbsent } from '../lib/movePanel';
import {
  buildMunitionsLedger,
  type MunitionsLedger,
} from '../lib/munitionsLedger';
import {
  LedgerBadge, absentReason, remainingClass, valueAttrs, clockZ,
} from './munitionsLedgerParts';

type SecondSourceEntry = ReturnType<typeof stockpileForLauncher>[number];

/** Pure view of one launcher's ledger rows (and, when present, the feed beside it). */
export function MunitionsLoadoutView({
  assetId, ledger, loading, secondSource,
}: {
  assetId: string;
  ledger: MunitionsLedger;
  loading: boolean;
  secondSource: SecondSourceEntry[];
}) {
  const rows = ledger.byType
    .flatMap((t) => t.rows)
    .filter((r) => r.launcherAssetId === assetId);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Target className="w-4 h-4 mr-2 text-amber-400" />
        Munitions Loadout
        <LedgerBadge />
      </h2>
      <div className="text-[10px] text-slate-500 mb-2" data-testid="loadout-provenance">
        Effector ledger for {assetId}: effector_launch + effector_resupply replayed in the
        browser; loaded = declared load from the deployment (effectors.declaredLoad); as of{' '}
        {clockZ(ledger.asOf)}
      </div>

      {rows.length === 0 ? (
        <div
          className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2"
          data-testid="loadout-empty"
          data-reason={loading ? 'loading' : 'no-ledger'}
        >
          {loading
            ? 'Loading effector ledger…'
            : 'No declared load and no recorded fire or resupply for this launcher'}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const undeclared = isAbsent(r.loaded);
            const pct = !isAbsent(r.loaded) && !isAbsent(r.remaining) && r.loaded.value > 0
              ? Math.max(0, Math.min(100, (r.remaining.value / r.loaded.value) * 100))
              : null;
            return (
              <div
                key={`${r.launcherAssetId}|${r.munitionKey}`}
                data-testid="loadout-row"
                data-launcher={r.launcherAssetId}
                data-munition={r.munitionKey}
                {...valueAttrs(r, {
                  expended: r.expended.value,
                  inFlight: r.inFlight.value,
                  unresolved: r.unresolved.value,
                  received: r.received.value,
                })}
              >
                <div className="flex justify-between items-center text-xs mb-1">
                  <span className="flex items-center text-slate-300">
                    <Package className="w-3 h-3 mr-1 text-slate-500" />
                    <span className="truncate font-mono" title={r.munitionKey}>{r.munitionKey}</span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums">
                    {undeclared ? (
                      <span className="text-amber-400 cursor-help" title={absentReason(r.loaded)}>
                        undeclared
                      </span>
                    ) : (
                      <>
                        <span className={remainingClass(r.remaining, r.loaded)}>
                          {isAbsent(r.remaining) ? '—' : r.remaining.value}
                        </span>
                        <span className="text-slate-500"> / {isAbsent(r.loaded) ? '—' : r.loaded.value}</span>
                      </>
                    )}
                  </span>
                </div>
                {pct !== null && (
                  <div className="w-full bg-slate-800 h-2 overflow-hidden border border-slate-700/50">
                    <div
                      className={`h-2 transition-all duration-1000 ${
                        pct === 0 ? 'bg-rose-500' : pct <= 25 ? 'bg-amber-500' : 'bg-emerald-500/80'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <div className="text-[10px] text-slate-500 font-mono mt-1">
                  expended {r.expended.value} · in flight {r.inFlight.value} · unresolved{' '}
                  {r.unresolved.value} · resupplied {r.received.value}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {secondSource.length > 0 && (
        <div className="mt-3 border border-slate-700 p-2" data-testid="loadout-second-source">
          <div className="text-[10px] text-slate-400 tracking-wider uppercase mb-1">
            Weapons-capability feed (second source)
          </div>
          {secondSource.map((e) => (
            <div key={e.capability_id} className="flex justify-between text-[11px] font-mono text-slate-400">
              <span className="truncate" title={e.munition_type}>
                {displayMunitionType(e.munition_type)}
              </span>
              <span className="tabular-nums">{e.current_ammo} / {e.initial_ammo}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MunitionsLoadoutCard({
  assetId,
}: {
  assetId: string | null | undefined;
}) {
  const fleet = useClassifiedFleet();
  const fleetAssets = useFleetAssets();
  const launches = useAllEffectorLaunches();
  const resupplies = useAllEffectorResupply();
  const stockpile = useMunitionsStockpile();
  const declaredLoad = moveInputs()?.declaredLoad;
  const nowMs = usePostureClock(5000);

  const ledger = useMemo(
    () => buildMunitionsLedger({
      fleet: fleetAssets.data
        .filter((a) => a.asset_id === assetId)
        .map((a) => ({
          assetId: a.asset_id,
          variant: a.platform_variant,
          regionId: a.region_id,
        })),
      launches: launches.data.filter((l) => l.launcherAssetId === assetId),
      resupplies: resupplies.data.filter((l) => l.launcherAssetId === assetId),
      declaredLoad,
      regionId: undefined,
      asOfMs: nowMs,
    }),
    [fleetAssets.data, launches.data, resupplies.data, declaredLoad, assetId, nowMs],
  );

  // Class of the selected asset drives the render-or-hide gate.
  const selectedClass = useMemo(() => {
    if (!assetId) return null;
    return fleet.data.find((a) => a.asset_id === assetId)?.asset_class ?? null;
  }, [fleet.data, assetId]);

  if (!assetId || selectedClass !== 'LAUNCHER') return null;

  return (
    <MunitionsLoadoutView
      assetId={assetId}
      ledger={ledger}
      loading={fleetAssets.isLoading || launches.isLoading || resupplies.isLoading}
      secondSource={stockpileForLauncher(stockpile.entries, assetId)}
    />
  );
}
