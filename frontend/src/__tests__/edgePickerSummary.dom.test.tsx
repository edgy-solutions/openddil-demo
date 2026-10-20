// @vitest-environment jsdom
// =============================================================================
// edgePickerSummary.dom -- withheld-only edges are selectable (F-2c1)
// =============================================================================
// An edge whose only assets are withheld has no fleet rows, so the picker
// learns of it from GET /arrivals/summary. A ?edge= naming it must survive
// the re-home effect once the summary has answered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import Root from '../Root';
import { installAuthMeFetch } from '../test-support/fetchAuthMe';
import {
  goToDemoLeafPath,
  primeSentinelFleet,
  resetSessionDomState,
  sentinelFleetRow,
} from '../test-support/sessionDom';

vi.mock('@electric-sql/react', () => import('../test-support/mockElectric'));
vi.mock('../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'off', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../components/DiagnosticCanvas', () => ({ default: () => null }));

type Summary = { status: number; edges?: unknown[] };

/** Layers /arrivals/summary over the auth stub. */
function installFetch(summary: Summary): void {
  installAuthMeFetch({ mode: 'ok', deltaSeconds: 3600 });
  const base = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    if (url === '/arrivals/summary') {
      return Promise.resolve(new Response(
        summary.edges ? JSON.stringify({ edges: summary.edges }) : null,
        { status: summary.status },
      ));
    }
    return base(url, init);
  }) as typeof fetch;
}

const edge = (edge_id: string, undeclared: number, expected: number) =>
  ({ edge_id, undeclared, expected, overdue: 0 });

const currentEdge = () => new URL(window.location.href).searchParams.get('edge');

beforeEach(() => {
  resetSessionDomState();
});
afterEach(() => {
  cleanup();
  resetSessionDomState();
});

async function mount(search: string, summary: Summary) {
  goToDemoLeafPath(search);
  installFetch(summary);
  primeSentinelFleet(sentinelFleetRow()); // edge-01
  const view = render(<Root />);
  await waitFor(() => {
    if (!view.container.querySelector('[data-testid="asset-identity"]')) throw new Error('not mounted');
  });
  // let the summary answer
  await new Promise((r) => setTimeout(r, 50));
  return view;
}

describe('maintainer edge picker with the arrivals summary', () => {
  it('keeps a ?edge= naming a summary-only edge (undeclared 1)', async () => {
    await mount('?role=maintainer&edge=edge-03', { status: 200, edges: [edge('edge-03', 1, 0)] });
    await waitFor(() => expect(currentEdge()).toBe('edge-03'));
    await new Promise((r) => setTimeout(r, 100));
    expect(currentEdge()).toBe('edge-03');
  });

  it('does not add an edge with undeclared 0 and expected 0 (re-homed)', async () => {
    await mount('?role=maintainer&edge=edge-03', { status: 200, edges: [edge('edge-03', 0, 0)] });
    await waitFor(() => expect(currentEdge()).toBe('edge-01'));
  });

  it('summary absent: behaves as today (re-homed)', async () => {
    await mount('?role=maintainer&edge=edge-03', { status: 404 });
    await waitFor(() => expect(currentEdge()).toBe('edge-01'));
  });

  it('an edge in neither source is re-homed after both have loaded', async () => {
    await mount('?role=maintainer&edge=edge-99', { status: 200, edges: [edge('edge-03', 1, 0)] });
    await waitFor(() => expect(currentEdge()).toBe('edge-01'));
  });
});
