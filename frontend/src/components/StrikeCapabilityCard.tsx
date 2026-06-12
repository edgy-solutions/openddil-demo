// =============================================================================
// StrikeCapabilityCard -- per-asset strike capability snapshot
// =============================================================================
// Renders the asset_capability_state row for one asset:
//   - one row per weapon/store entry in capabilities[]
//   - ammo count vs the configured low-ammo threshold (LOW / DEPLETED badge
//     when at or below threshold, OK otherwise)
//   - capability_id, store category/location, accepted command interfaces
//
// Mounted in the Maintainer right-rail next to LogisticsStatusCard.
// The card renders nothing only when the asset has no capability_state row
// at all (non-strike-capable assets -- sensors, HQ facilities, etc.). When
// the asset HAS a row but capabilities[] is empty, we show a thin "no
// capabilities reported" line so the operator sees the row exists.
import { Crosshair } from 'lucide-react';
import { useCapabilityState, type CapabilityStore } from '../hooks';

/** Default threshold matches logistics-fusion's ammo_low_count (thresholds.py).
 *  When AMMO_LOW_COUNT env on logistics-fusion is overridden, this client-side
 *  default doesn't see it -- the badge here is informational, not authoritative.
 *  Future: read from a shared settings table so client + server agree. */
const DEFAULT_AMMO_LOW = 5;
const DEFAULT_AMMO_DEPLETED = 0;

function ammoBadge(ammo: number, lowThreshold: number): { label: string; cls: string } {
  if (ammo <= DEFAULT_AMMO_DEPLETED) {
    return { label: 'DEPLETED', cls: 'bg-rose-700/30 text-rose-300 border-rose-700/60' };
  }
  if (ammo <= lowThreshold) {
    return { label: 'LOW', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
  }
  return { label: 'OK', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
}

function StoreRow({ store, lowThreshold }: { store: CapabilityStore; lowThreshold: number }) {
  const badge = ammoBadge(store.ammo, lowThreshold);
  // capability_id is long ("<asset>_<weapon_variant>"); trim to the weapon
  // part after the last underscore for a tight display.
  const weaponLabel = (() => {
    const id = store.capability_id || '';
    const parts = id.split('_');
    // Heuristic: capability_id ends with the variant name (e.g. "..._SHORAD_Interceptor")
    // -- take the trailing two segments if they look variant-y.
    return parts.slice(-2).join('_') || id || '(unnamed)';
  })();

  return (
    <div className="border-l-2 border-slate-600 pl-2 py-0.5 text-[11px]">
      <div className="flex justify-between items-center">
        <span className="text-slate-300 truncate" title={store.capability_id}>{weaponLabel}</span>
        <span className={`text-[9px] font-bold px-1 py-px rounded-sm border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <div className="text-slate-500 text-[10px] flex gap-3 mt-0.5">
        <span>
          <span className="text-slate-400">ammo</span>{' '}
          <span className={
            store.ammo <= DEFAULT_AMMO_DEPLETED
              ? 'text-rose-300 font-bold'
              : store.ammo <= lowThreshold
                ? 'text-amber-300 font-bold'
                : 'text-emerald-300'
          }>{store.ammo}</span>
        </span>
        {store.store_category && (
          <span>
            <span className="text-slate-400">cat</span> {store.store_category}
          </span>
        )}
        {store.store_location != null && (
          <span>
            <span className="text-slate-400">slot</span> {store.store_location}
          </span>
        )}
        {store.simulated && (
          <span className="text-slate-600 italic">simulated</span>
        )}
      </div>
    </div>
  );
}

interface Props {
  assetId: string;
  /** Optional override for the low-ammo display threshold. Defaults to 5
   *  (matches logistics-fusion's ammo_low_count). Pass in to make the badge
   *  match a deployment's AMMO_LOW_COUNT env override. */
  ammoLowThreshold?: number;
}

export function StrikeCapabilityCard({ assetId, ammoLowThreshold }: Props) {
  const { data } = useCapabilityState(assetId);
  const lowThreshold = ammoLowThreshold ?? DEFAULT_AMMO_LOW;
  const row = data?.[0];

  // No capability row => non-strike-capable asset (sensor, HQ, etc.). Hide.
  //
  // Important: gate on `!row` ONLY, not on `!isLoading && !row`. The latter
  // form caused a visible flash on every initial mount for non-strike
  // assets: during loading the outer card + <SyncingNotice> rendered,
  // then after the load resolved to "no row" we returned null and the
  // card disappeared. By keying off row alone, the card is invisible
  // throughout the entire never-going-to-have-data lifecycle. For
  // strike-capable assets the card pops in once the row arrives -- no
  // loading skeleton, but no flicker either. Acceptable trade because
  // useCapabilityState typically resolves quickly and a brief delay is
  // less noisy than a flash-and-disappear.
  if (!row) return null;

  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded p-2 text-xs">
      <div className="flex items-center gap-2 mb-2">
        <Crosshair className="w-3 h-3 text-cyan-400" />
        <span className="text-cyan-400 font-bold tracking-wider text-[10px]">STRIKE CAPABILITY</span>
      </div>

      {row && (
        <>
          {row.capabilities.length === 0 ? (
            <div className="text-slate-500 italic text-[11px]">
              no capabilities reported
            </div>
          ) : (
            <div className="space-y-1">
              {row.capabilities.map((store, i) => (
                <StoreRow
                  key={store.capability_id || `store-${i}`}
                  store={store}
                  lowThreshold={lowThreshold}
                />
              ))}
            </div>
          )}

          {row.mode && (
            <div className="text-slate-600 text-[9px] mt-2 pt-1 border-t border-slate-800 flex justify-between">
              <span>mode: <span className="text-slate-400">{row.mode}</span></span>
              {row.observed_at && (
                <span title={row.observed_at}>
                  obs: {new Date(row.observed_at).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}

          <div className="text-slate-600 text-[9px] mt-1">
            ammo threshold (display): {lowThreshold} -- LOW at-or-below, DEPLETED at 0
          </div>
        </>
      )}
    </div>
  );
}
