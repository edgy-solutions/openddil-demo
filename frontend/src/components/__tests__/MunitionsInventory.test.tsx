// @vitest-environment jsdom
// MunitionsLedgerView -- the pure view, rendered from a built ledger
// (renderToStaticMarkup, as in MovePanel.test.tsx).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MunitionsLedgerView } from '../hq/MunitionsInventory';
import { buildMunitionsLedger } from '../../lib/munitionsLedger';

const KEY = '2.1.225.1.0.0.0';
const T0 = Date.parse('2026-10-06T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function ledger(regionId?: string) {
  return buildMunitionsLedger({
    fleet: [{ assetId: 'L1', variant: 'V', regionId: 'r1' }],
    declaredLoad: { asset: {}, variant: { V: { [KEY]: 5 } } },
    launches: [
      { launcherAssetId: 'L1', munitionType: KEY, quantity: 2, launchedAt: at(60), terminalState: 'entity_impact', regionId: 'r1' },
      { launcherAssetId: 'L1', munitionType: KEY, quantity: 1, launchedAt: at(120), terminalState: null, regionId: 'r1' },
      { launcherAssetId: 'L2', munitionType: KEY, quantity: 1, launchedAt: at(130), terminalState: null, regionId: 'r2' },
    ],
    resupplies: [],
    tracks: [
      { launcherAssetId: 'L1', munitionType: KEY, terminalState: null },
      { launcherAssetId: 'L2', munitionType: KEY, terminalState: null },
    ],
    regionId,
    asOfMs: T0 + 150_000,
  });
}

const CAPABILITY = {
  byType: [{ munition_type: 'SOME_TYPE', available: 3, expended: 1, initial: 4, launcher_count: 1 }],
  totals: { available: 3, expended: 1, initial: 4 },
  reset: () => {},
};

function html(over: Partial<Parameters<typeof MunitionsLedgerView>[0]> = {}) {
  return renderToStaticMarkup(
    <MunitionsLedgerView title="Munitions" ledger={ledger()} loading={false} capability={null} {...over} />,
  );
}

describe('MunitionsLedgerView', () => {
  it('shows the provenance line and the LEDGER badge', () => {
    const h = html();
    expect(h).toContain('data-testid="munitions-provenance"');
    expect(h).toContain('effector_launch + effector_resupply replayed in the browser');
    expect(h).toContain('effectors.declaredLoad');
    expect(h).toContain('as of 12:02:30Z');
    expect(h).toContain('LEDGER');
    expect(h).not.toContain('DERIVED');
  });

  it('renders a type row with raw key and value attributes', () => {
    const h = html();
    expect(h).toContain('data-testid="munitions-type-row"');
    expect(h).toContain(`data-munition="${KEY}"`);
    expect(h).toContain('data-scope="theater"');
    expect(h).toContain('data-loaded="5"');
    expect(h).toContain('data-remaining="2"');
    expect(h).toContain('data-expended="3"');
    expect(h).toContain('data-inflight="2"');
    expect(h).toContain('data-launchers="2"');
    expect(h).toContain('data-undeclared="1"');
    expect(h).toContain('+1 undecl.');
  });

  it('renders declared and undeclared launcher rows', () => {
    const h = html();
    const rows = h.split('data-testid="munitions-launcher-row"').slice(1);
    expect(rows).toHaveLength(2);
    const l1 = rows[0];
    const l2 = rows[1].split('data-testid="munitions-region')[0];
    expect(l1).toContain('data-launcher="L1"');
    expect(l1).toContain('data-region="r1"');
    expect(l1).toContain('data-loaded="5"');
    expect(l1).toContain('L1 (V)');
    expect(l2).toContain('data-launcher="L2"');
    expect(l2).toContain('data-region="r2"');
    expect(l2).toContain('data-loaded-absent="no declared load for L2"');
    expect(l2).toContain('data-remaining-absent="no declared load for L2"');
    expect(l2).not.toContain('data-loaded="');
    expect(l2).toContain('undeclared');
  });

  it('shows by-region sections in theater scope only', () => {
    const theater = html();
    expect(theater).toContain('data-testid="munitions-region"');
    expect(theater).toContain('data-region="r2"');
    expect(theater).toContain('data-testid="munitions-region-type-row"');

    const scoped = html({ ledger: ledger('r1') });
    expect(scoped).toContain('data-scope="r1"');
    expect(scoped).not.toContain('munitions-region"');
    expect(scoped).not.toContain('munitions-region-type-row');
    expect(scoped).not.toContain('data-launcher="L2"');
  });

  it('renders the second source only when capability is given', () => {
    expect(html()).not.toContain('munitions-second-source');
    const h = html({ capability: CAPABILITY });
    expect(h).toContain('data-testid="munitions-second-source"');
    expect(h).toContain('Second source: weapons-capability feed (not merged with the ledger)');
    expect(h).toContain('RESET');
  });

  it('explains an empty ledger by cause', () => {
    const empty = buildMunitionsLedger({
      fleet: [], launches: [], resupplies: [], tracks: [], declaredLoad: undefined, asOfMs: T0,
    });
    const loading = html({ ledger: empty, loading: true });
    expect(loading).toContain('data-testid="munitions-empty"');
    expect(loading).toContain('data-reason="loading"');
    expect(loading).toContain('Loading effector ledger…');
    const done = html({ ledger: empty });
    expect(done).toContain('data-reason="no-launchers"');
    expect(done).toContain('No launcher in this scope has a declared load or a recorded fire/resupply');
  });
});
