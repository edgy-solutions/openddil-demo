// =============================================================================
// useMunitionsStockpile -- per-launcher + per-type munitions rollup
// =============================================================================
// Derives Phase 3 munitions inventory from the existing
// asset_capability_state Electric shape. No schema change, no projector
// change: everything lives in the frontend as a running max-seen
// accumulator + a memoized rollup.
//
// KEY DERIVATION
//   * current_ammo  -- read verbatim from the incoming capabilities[].ammo
//   * initial_ammo  -- the MAX current_ammo observed for this
//                      (launcher_asset_id, capability_id) across the
//                      session, tracked in a ref-based Map that survives
//                      re-renders. On the natural firing curve (start high,
//                      drop as missiles fire) this equals the true starting
//                      value; on a reload (current transiently exceeds
//                      previous max) the max bumps up cleanly.
//   * expended      -- max(0, initial_ammo - current_ammo). Guarded against
//                      negatives even though max-seen precludes them.
//   * munition_type -- src/lib/munitionType.ts strips the launcher prefix.
//
// KNOWN LIMITATIONS (call out in the UI)
//   1. Cold-start mid-scenario: if the user loads the page AFTER firing
//      began, max_seen is capped at whatever the current_ammo was at
//      first-observe, so expended reads as 0 until further firing occurs.
//      No auto-fix here; the Reset button + a fresh-scenario workflow
//      are the honest answer.
//   2. Post-flush drift: after a cluster flush the ammo values may
//      transiently be 0 (empty table) before the source republishes
//      capability snapshots. Once new values arrive higher than the
//      ref cache's max, the max bumps up and expended naturally
//      realigns to the new scenario. But if the new scenario starts
//      LOWER than the previous one's max, expended overcounts until
//      the operator clicks Reset.
//   3. No persistence across page reload -- the ref cache lives in
//      component memory. Reload = starts over. Acceptable for demo.
//
// The `reset()` callback zeros the accumulator so the operator can
// realign after a cluster flush or a scenario change.
// =============================================================================
import { useCallback, useMemo, useRef, useState } from 'react';

import { useAllCapabilityState } from './useCapabilityState';
import { extractMunitionType } from '../lib/munitionType';

/** One row per (launcher, capability_id). */
export interface StockpileEntry {
  launcher_asset_id: string;
  capability_id:     string;
  munition_type:     string;
  current_ammo:      number;
  initial_ammo:      number;
  expended:          number;
}

/** One rollup row per munition_type across the whole fleet. */
export interface MunitionTypeRollup {
  munition_type: string;
  available:     number;   // sum of current_ammo across launchers
  expended:      number;   // sum of expended across launchers
  initial:       number;   // sum of initial_ammo (= available + expended)
  launcher_count: number;  // number of distinct launchers carrying this type
}

export interface MunitionsStockpileResult {
  /** Per-(launcher, capability) rows. */
  entries: StockpileEntry[];
  /** Per-munition-type totals. */
  byType: MunitionTypeRollup[];
  /** Fleet-wide sums. */
  totals: {
    available: number;
    expended: number;
    initial: number;
  };
  /** Zero the running max-seen accumulator (post-flush recovery). */
  reset: () => void;
  isLoading: boolean;
  isError:   boolean;
}

/** Cache-key format: `<launcher_asset_id>|<capability_id>`. Pipe is
 *  safe because neither field carries it in customer data (both come
 *  from CamelCase/underscore-joined identifiers). */
function cacheKey(launcherId: string, capId: string): string {
  return `${launcherId}|${capId}`;
}

export function useMunitionsStockpile(): MunitionsStockpileResult {
  const caps = useAllCapabilityState();

  // Running max-seen ammo per (launcher, capability). Ref-based so it
  // survives re-renders without triggering re-computation. Every render
  // consults + updates it before producing the rollup.
  const maxSeenRef = useRef<Map<string, number>>(new Map());

  // Version counter forces useMemo re-execution when reset() runs. Cheap
  // because the memo body is fast anyway.
  const [version, setVersion] = useState(0);

  const reset = useCallback(() => {
    maxSeenRef.current = new Map();
    setVersion((v) => v + 1);
  }, []);

  // Flatten (launcher, capabilities[]) -> entries with derived initial +
  // expended. Update max-seen for each (launcher, cap_id) on the way
  // through -- this is the only mutation, and it's idempotent w.r.t.
  // the same data (Math.max is a fixed point).
  const entries = useMemo<StockpileEntry[]>(() => {
    const out: StockpileEntry[] = [];
    const maxSeen = maxSeenRef.current;
    for (const row of caps.data) {
      const launcherId = row.asset_id;
      for (const store of row.capabilities ?? []) {
        const capId = String(store?.capability_id ?? '');
        // Coerce numeric ammo -- Electric returns numbers as strings
        // sometimes; guard with Number() + fallback to 0.
        const currentAmmo = Number(store?.ammo ?? 0) || 0;
        const key = cacheKey(launcherId, capId);
        const prevMax = maxSeen.get(key) ?? 0;
        const nextMax = Math.max(prevMax, currentAmmo);
        if (nextMax !== prevMax) {
          maxSeen.set(key, nextMax);
        }
        out.push({
          launcher_asset_id: launcherId,
          capability_id:     capId,
          munition_type:     extractMunitionType(capId, launcherId),
          current_ammo:      currentAmmo,
          initial_ammo:      nextMax,
          expended:          Math.max(0, nextMax - currentAmmo),
        });
      }
    }
    return out;
    // `version` in the dep list forces re-run on reset() -- we
    // intentionally include it even though the loop doesn't reference
    // it directly. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.data, version]);

  const byType = useMemo<MunitionTypeRollup[]>(() => {
    const map = new Map<string, MunitionTypeRollup>();
    for (const e of entries) {
      const key = e.munition_type;
      let row = map.get(key);
      if (!row) {
        row = {
          munition_type:  key,
          available:      0,
          expended:       0,
          initial:        0,
          launcher_count: 0,
        };
        map.set(key, row);
      }
      row.available      += e.current_ammo;
      row.expended       += e.expended;
      row.initial        += e.initial_ammo;
      row.launcher_count += 1;
    }
    // Sort by initial capacity desc so the largest-stockpile types
    // read first (typical operator scan order).
    return Array.from(map.values()).sort(
      (a, b) => b.initial - a.initial || a.munition_type.localeCompare(b.munition_type),
    );
  }, [entries]);

  const totals = useMemo(() => {
    let available = 0, expended = 0, initial = 0;
    for (const r of byType) {
      available += r.available;
      expended  += r.expended;
      initial   += r.initial;
    }
    return { available, expended, initial };
  }, [byType]);

  return {
    entries,
    byType,
    totals,
    reset,
    isLoading: caps.isLoading,
    isError:   caps.isError,
  };
}

/** Per-launcher slice, for the maintainer-view Munitions Loadout card.
 *  Returns entries filtered to one launcher. Small enough to be an
 *  in-render filter; no need for a separate hook or memo. */
export function stockpileForLauncher(
  entries: StockpileEntry[],
  launcherAssetId: string | null | undefined,
): StockpileEntry[] {
  if (!launcherAssetId) return [];
  return entries.filter((e) => e.launcher_asset_id === launcherAssetId);
}
