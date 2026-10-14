// Row helpers shared by the ledger-reading cards (inventory rollup and the
// per-launcher loadout card), so both render the same numbers the same way.
import { isAbsent, type Maybe } from '../lib/movePanel';

export function LedgerBadge() {
  return (
    <span
      className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-emerald-700/50 bg-emerald-900/30 text-emerald-400 uppercase rounded-sm cursor-help"
      title={
        "Effector ledger: effector_launch and effector_resupply replayed in the browser. " +
        "Loaded is the declared load from the deployment; remaining = loaded - expended. " +
        "A launcher with no declared load has no remaining figure."
      }
    >
      LEDGER
    </span>
  );
}

export function absentReason(m: Maybe<number>): string | undefined {
  return isAbsent(m) ? m.absent : undefined;
}

export function numOrDash(m: Maybe<number>) {
  return isAbsent(m)
    ? <span className="text-slate-600 cursor-help" title={m.absent}>—</span>
    : <>{m.value}</>;
}

// Rose when nothing is left, amber when a quarter or less of the load is left.
export function remainingClass(remaining: Maybe<number>, loaded: Maybe<number>): string {
  if (isAbsent(remaining)) return 'text-slate-500';
  if (remaining.value <= 0) return 'text-rose-400 font-bold';
  if (!isAbsent(loaded) && loaded.value > 0 && remaining.value <= loaded.value * 0.25) return 'text-amber-400';
  return 'text-emerald-400';
}

export function valueAttrs(
  r: { loaded: Maybe<number>; remaining: Maybe<number> },
  n: { expended: number; inFlight: number; unresolved: number; received: number },
) {
  const loadedAbsent = absentReason(r.loaded);
  const remainingAbsent = absentReason(r.remaining);
  return {
    'data-loaded': loadedAbsent === undefined ? (r.loaded as { value: number }).value : undefined,
    'data-loaded-absent': loadedAbsent,
    'data-remaining': remainingAbsent === undefined ? (r.remaining as { value: number }).value : undefined,
    'data-remaining-absent': remainingAbsent,
    'data-expended': n.expended,
    'data-inflight': n.inFlight,
    'data-unresolved': n.unresolved,
    'data-received': n.received,
  };
}

export function clockZ(iso: string): string {
  return iso ? `${iso.slice(11, 19)}Z` : '—';
}
