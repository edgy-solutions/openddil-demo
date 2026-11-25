// @vitest-environment jsdom
// Mounts the real RegionalApp so the reports pane in its right-hand column is
// covered. Mocked: useSession and useLinkControl (each would otherwise fetch
// from a gateway), and useShape from the Electric client (the one read path
// under every fleet/rollup/launch hook; it would open a live sync). The
// reports fetch is stubbed as in ReportsPane.dom.test.tsx. Stubbed child:
// RegionalSustainmentPosture (a three.js canvas; jsdom has no ResizeObserver or
// WebGL). Everything else renders for real. useShape answers per table from
// h.rows (empty unless a case fills it). Synthetic ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import RegionalApp from '../RegionalApp';
import { __setReportsForTest } from '../deployment';
import type { Session } from '../hooks/useSession';
import type { UseLinkControlResult } from '../hooks/useLinkControl';

const h = vi.hoisted(() => ({
  role: 'observer',
  // Fixture rows by Postgres table, as the Electric client returns them. Empty
  // by default, so a table nobody filled answers [] as it always did.
  rows: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../hooks/useSession', async (orig) => {
  const real = await orig<typeof import('../hooks/useSession')>();
  const session = (): Session => ({
    authenticated: true, subject: 'user-a1', username: 'user-a1', name: 'User A1',
    nations: [], nationRegistry: [], role: h.role, mayResolveDiscrepancy: false,
    policyVersion: null, authDisabled: false, expiresAt: null, sessionError: null,
  });
  return { ...real, useSession: session };
});

vi.mock('../hooks/useLinkControl', () => ({
  useLinkControl: (): UseLinkControlResult => ({
    status: 'off', uplink: null, children: [], set: () => {}, setToxics: () => {},
  }),
}));

vi.mock('@electric-sql/react', () => ({
  useShape: (opts?: { params?: { table?: string } }) => ({
    data: h.rows[opts?.params?.table ?? ''] ?? [],
    isLoading: false, isError: false, error: undefined,
  }),
}));

vi.mock('../components/regional/RegionalSustainmentPosture', () => ({
  default: () => <div data-testid="stub-regional-sustainment-posture" />,
}));

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ reports: [], unmatched_ledger: [] }), { status: 200 })));
}

const NOTE = "Until closed episodes are carried up, this region's reports show only its own.";

const REGION = 'region-t1';
const ASSET = 'asset-t1';
const CALLSIGN = 'TESTCALL-1';
const ASSET_ROWS = {
  region_fleet_summary: [{ region_id: REGION, releasability_class: 'class-t1', asset_count: 1 }],
  telemetry_latest_state: [{
    asset_id: ASSET, platform_variant: 'T1_Platform', callsign: CALLSIGN,
    region_id: REGION, edge_id: 'edge-t1', schema_revision: 1,
  }],
  asset_logistics_status: [{ asset_id: ASSET, overall_severity: 'LOGISTICS_SEVERITY_NOMINAL' }],
};

beforeEach(() => {
  h.role = 'observer';
  h.rows = {};
  stubFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  __setReportsForTest(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RegionalApp reports pane', () => {
  it('mounts the pane in the right-hand column with the region note once', async () => {
    render(<RegionalApp />);
    const pane = await screen.findByTestId('reports-pane');
    expect(pane).toBeTruthy();
    const column = pane.closest('div.col-span-1');
    expect(column).not.toBeNull();
    const notes = within(column as HTMLElement).getAllByTestId('reports-region-note');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(NOTE);
    expect(screen.getAllByTestId('reports-region-note')).toHaveLength(1);
  });

  it('drops the note, keeps the pane, when closed episodes are carried up', async () => {
    __setReportsForTest({ closesCarriedUp: true });
    render(<RegionalApp />);
    expect(await screen.findByTestId('reports-pane')).toBeTruthy();
    expect(screen.queryByTestId('reports-region-note')).toBeNull();
  });

  it.each([['supervisor', 2], ['maintainer', 1]])('renders the pane and one note as %s (%i lists)', async (role, lists) => {
    h.role = role as string;
    render(<RegionalApp />);
    expect(await screen.findAllByTestId('reports-pane')).toHaveLength(lists as number);
    expect(screen.getAllByTestId('reports-region-note')).toHaveLength(1);
  });
});

describe('RegionalApp with an asset selected', () => {
  beforeEach(() => { h.rows = ASSET_ROWS; });
  const assetButton = () => screen.queryAllByTitle(ASSET);

  it('lists the asset beside the reports pane and the note', async () => {
    render(<RegionalApp />);
    expect(await screen.findByTestId('reports-pane')).toBeTruthy();
    const buttons = assetButton();
    expect(buttons).toHaveLength(1);
    expect(buttons[0].tagName).toBe('BUTTON');
    expect(buttons[0].textContent).toContain(CALLSIGN);
    expect(screen.getAllByTestId('reports-region-note')).toHaveLength(1);
  });

  it('opens the deep dive on click and takes the column over', async () => {
    render(<RegionalApp />);
    await screen.findByTestId('reports-pane');
    fireEvent.click(assetButton()[0]);
    expect(await screen.findByText(/DEEP DIVE/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: CALLSIGN })).toBeTruthy();
    expect(screen.getByRole('button', { name: /CLOSE/ })).toBeTruthy();
    expect(screen.queryAllByTestId('reports-pane')).toHaveLength(0);
    expect(screen.queryAllByTestId('reports-region-note')).toHaveLength(0);
    expect(assetButton()).toHaveLength(0);
  });

  it('brings the column back on close', async () => {
    render(<RegionalApp />);
    await screen.findByTestId('reports-pane');
    fireEvent.click(assetButton()[0]);
    fireEvent.click(await screen.findByRole('button', { name: /CLOSE/ }));
    expect(await screen.findAllByTestId('reports-pane')).toHaveLength(1);
    expect(screen.getAllByTestId('reports-region-note')).toHaveLength(1);
    expect(assetButton()).toHaveLength(1);
    expect(screen.queryByText(/DEEP DIVE/)).toBeNull();
  });

  it.each([['supervisor', 2], ['maintainer', 1]])('removes all %s panes (%i) when selected', async (role, lists) => {
    h.role = role as string;
    render(<RegionalApp />);
    expect(await screen.findAllByTestId('reports-pane')).toHaveLength(lists as number);
    fireEvent.click(assetButton()[0]);
    expect(await screen.findByText(/DEEP DIVE/)).toBeTruthy();
    expect(screen.queryAllByTestId('reports-pane')).toHaveLength(0);
    expect(screen.queryAllByTestId('reports-region-note')).toHaveLength(0);
  });
});
