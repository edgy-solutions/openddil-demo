// @vitest-environment jsdom
// MunitionsLoadoutView -- the pure view, rendered from a built ledger.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MunitionsLoadoutView } from '../MunitionsLoadoutCard';
import { buildMunitionsLedger } from '../../lib/munitionsLedger';

const KEY = '2.1.225.1.0.0.0';
const T0 = Date.parse('2026-10-06T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

type Launch = { terminalState: string | null; quantity: number; s: number };

function ledger(launches: Launch[], opts: { declared?: boolean; resupply?: boolean } = {}) {
  const { declared = true, resupply = false } = opts;
  return buildMunitionsLedger({
    fleet: [{ assetId: 'L1', variant: 'MRAD_Interceptor', regionId: 'r1' }],
    declaredLoad: declared ? { asset: {}, variant: { MRAD_Interceptor: { [KEY]: 5 } } } : undefined,
    launches: launches.map((l) => ({
      launcherAssetId: 'L1', munitionType: KEY, quantity: l.quantity,
      launchedAt: at(l.s), terminalState: l.terminalState, regionId: 'r1',
    })),
    resupplies: resupply
      ? [{ launcherAssetId: 'L1', munitionType: KEY, quantity: 1, receivedAt: at(200), regionId: 'r1' }]
      : [],
    regionId: undefined,
    asOfMs: T0 + 300_000,
  } as Parameters<typeof buildMunitionsLedger>[0]);
}

function html(over: Partial<Parameters<typeof MunitionsLoadoutView>[0]> = {}) {
  return renderToStaticMarkup(
    <MunitionsLoadoutView
      assetId="L1"
      ledger={ledger([])}
      loading={false}
      secondSource={[]}
      {...over}
    />,
  );
}

const FIVE: Launch[] = [
  { terminalState: 'entity_impact', quantity: 2, s: 60 },
  { terminalState: 'ground_impact', quantity: 1, s: 120 },
  { terminalState: 'unresolved', quantity: 1, s: 130 },
];

describe('MunitionsLoadoutView', () => {
  it('renders one declared row with ledger numbers', () => {
    const h = html({ ledger: ledger(FIVE, { resupply: true }) });
    expect(h.split('data-testid="loadout-row"').length - 1).toBe(1);
    expect(h).toContain('data-loaded="5"');
    expect(h).toContain('data-expended="3"');
    expect(h).toContain('data-remaining="2"');
    expect(h).toContain('data-inflight="0"');
    expect(h).toContain('data-unresolved="1"');
    expect(h).toContain('data-received="1"');
    expect(h).not.toContain('loadout-second-source');
    expect(h).toContain('data-testid="loadout-provenance"');
    expect(h).toContain('LEDGER');
    expect(h).not.toContain('DERIVED');
    expect(h).not.toContain('Not carried');
  });

  it('counts a launch with no terminal state as in flight', () => {
    const h = html({ ledger: ledger([{ terminalState: null, quantity: 1, s: 60 }]) });
    expect(h).toContain('data-inflight="1"');
  });

  it('shows undeclared when there is no declared load', () => {
    const h = html({ ledger: ledger(FIVE, { declared: false }) });
    expect(h).toContain('data-loaded-absent=');
    expect(h).toContain('data-remaining-absent=');
    expect(h).toContain('undeclared');
    expect(h).not.toContain('data-loaded="');
  });

  it('shows the empty state with its reason', () => {
    const none = ledger([], { declared: false });
    expect(html({ ledger: none })).toContain('data-reason="no-ledger"');
    expect(html({ ledger: none, loading: true })).toContain('data-reason="loading"');
  });

  it('shows the second source beside the ledger row', () => {
    const h = html({
      ledger: ledger(FIVE),
      secondSource: [{
        launcher_asset_id: 'L1', capability_id: 'c1', munition_type: 'SOME_TYPE',
        current_ammo: 3, initial_ammo: 4, expended: 1,
      }],
    });
    expect(h).toContain('data-testid="loadout-second-source"');
    expect(h).toContain('data-testid="loadout-row"');
  });
});
