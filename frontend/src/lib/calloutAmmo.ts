// =============================================================================
// calloutAmmo — the "· remaining/loaded" tail on a launcher's 3D map callout
// =============================================================================
// Same order of sources as the loadout card and the inventory card:
//   1. the effector ledger (ADR-0048): remaining / loaded, summed over the
//      launcher's munition types. Used only when every row has a declared
//      load -- an undeclared row has no remaining, and a partial sum would
//      read as a count it is not.
//   2. the capability feed (useMunitionsStockpile): current / max-seen,
//      when the ledger cannot answer and the feed carries the launcher.
//   3. neither: null, and the callout shows no tail. Never a zero.
import { isAbsent } from './movePanel';
import type { MunitionsLedger } from './munitionsLedger';
import type { StockpileEntry } from '../hooks/useMunitionsStockpile';

export interface CalloutAmmo {
  text: string;
  depleted: boolean;
  source: 'ledger' | 'feed';
}

export function calloutAmmo(
  launcherAssetId: string,
  ledger: MunitionsLedger,
  feed: StockpileEntry[],
): CalloutAmmo | null {
  const rows = ledger.byType.flatMap((t) => t.rows).filter((r) => r.launcherAssetId === launcherAssetId);
  if (rows.length > 0 && rows.every((r) => !isAbsent(r.remaining) && !isAbsent(r.loaded))) {
    let remaining = 0;
    let loaded = 0;
    for (const r of rows) {
      if (!isAbsent(r.remaining)) remaining += r.remaining.value;
      if (!isAbsent(r.loaded)) loaded += r.loaded.value;
    }
    return { text: `${remaining}/${loaded}`, depleted: remaining === 0 && loaded > 0, source: 'ledger' };
  }
  const stores = feed.filter((e) => e.launcher_asset_id === launcherAssetId);
  if (stores.length > 0) {
    const cur = stores.reduce((s, r) => s + r.current_ammo, 0);
    const max = stores.reduce((s, r) => s + r.initial_ammo, 0);
    return { text: `${cur}/${max}`, depleted: cur === 0 && max > 0, source: 'feed' };
  }
  return null;
}
