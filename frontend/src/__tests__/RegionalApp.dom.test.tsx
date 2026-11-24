// @vitest-environment jsdom
// Mounts the real RegionalApp so the reports pane in its right-hand column is
// covered. Mocked: useSession and useLinkControl (each would otherwise fetch
// from a gateway), and useShape from the Electric client (the one read path
// under every fleet/rollup/launch hook; it would open a live sync). The
// reports fetch is stubbed as in ReportsPane.dom.test.tsx. Stubbed child:
// RegionalSustainmentPosture (a three.js canvas; jsdom has no ResizeObserver or
// WebGL). Everything else renders for real. Synthetic ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import RegionalApp from '../RegionalApp';
import { __setReportsForTest } from '../deployment';
import type { Session } from '../hooks/useSession';
import type { UseLinkControlResult } from '../hooks/useLinkControl';

const h = vi.hoisted(() => ({ role: 'observer' }));

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
  useShape: () => ({ data: [], isLoading: false, isError: false, error: undefined }),
}));

vi.mock('../components/regional/RegionalSustainmentPosture', () => ({
  default: () => <div data-testid="stub-regional-sustainment-posture" />,
}));

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ reports: [], unmatched_ledger: [] }), { status: 200 })));
}

const NOTE = "Until closed episodes are carried up, this region's reports show only its own.";

beforeEach(() => {
  h.role = 'observer';
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
