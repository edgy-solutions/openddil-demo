import { describe, expect, it } from 'vitest';
import { calloutAmmo } from '../calloutAmmo';
import { buildMunitionsLedger, type LedgerLaunchInput } from '../munitionsLedger';
import type { StockpileEntry } from '../../hooks/useMunitionsStockpile';

const KEY = '2.1.225.1.0.0.0';
const T0 = Date.parse('2026-10-06T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const FLEET = [
  { assetId: 'L1', variant: 'V', regionId: 'r1' },
  { assetId: 'L2', variant: 'W', regionId: 'r1' },
];
const LOAD = { asset: {}, variant: { V: { [KEY]: 5 } } };
const LAUNCHES: LedgerLaunchInput[] = [
  { launcherAssetId: 'L1', munitionType: KEY, quantity: 2, launchedAt: at(60), terminalState: 'entity_impact', regionId: 'r1' },
  { launcherAssetId: 'L2', munitionType: KEY, quantity: 1, launchedAt: at(60), terminalState: null, regionId: 'r1' },
];
const ledger = (launches = LAUNCHES) => buildMunitionsLedger({
  fleet: FLEET, launches, resupplies: [], tracks: [], declaredLoad: LOAD, asOfMs: T0 + 300_000,
});
const feed = (id: string, cur: number, max: number): StockpileEntry => ({
  launcher_asset_id: id, capability_id: 'c', munition_type: KEY, current_ammo: cur, initial_ammo: max, expended: max - cur,
});

describe('calloutAmmo', () => {
  it('reads remaining/loaded from the ledger when the feed is empty', () => {
    expect(calloutAmmo('L1', ledger(), [])).toEqual({ text: '3/5', depleted: false, source: 'ledger' });
  });

  it('prefers the ledger over the feed', () => {
    expect(calloutAmmo('L1', ledger(), [feed('L1', 9, 12)])?.source).toBe('ledger');
  });

  it('marks a declared launcher at zero as depleted', () => {
    const five = [{ ...LAUNCHES[0], quantity: 5 }];
    expect(calloutAmmo('L1', ledger(five), [])).toEqual({ text: '0/5', depleted: true, source: 'ledger' });
  });

  it('falls back to the feed for an undeclared launcher, never a partial ledger count', () => {
    expect(calloutAmmo('L2', ledger(), [feed('L2', 10, 12)])).toEqual({ text: '10/12', depleted: false, source: 'feed' });
  });

  it('shows no tail when neither source carries the launcher', () => {
    expect(calloutAmmo('L2', ledger(), [])).toBeNull();
    expect(calloutAmmo('X9', ledger(), [])).toBeNull();
  });
});
