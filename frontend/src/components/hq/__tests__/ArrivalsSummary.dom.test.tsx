// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import ArrivalsSummary from '../ArrivalsSummary';

const EDGES = [
  { edge_id: 'edge-01', undeclared: 0, expected: 2, overdue: 1 },
  { edge_id: 'edge-02', undeclared: 0, expected: 0, overdue: 0 },
  { edge_id: 'edge-03', undeclared: 1, expected: 0, overdue: 0 },
];

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArrivalsSummary', () => {
  it('renders one row per edge, in order, with its text', async () => {
    mockFetch(200, { edges: EDGES });
    render(<ArrivalsSummary />);
    await waitFor(() => expect(screen.getAllByTestId('arrivals-summary-row')).toHaveLength(3));
    const rows = screen.getAllByTestId('arrivals-summary-row').map((r) => r.textContent);
    expect(rows).toEqual([
      'edge-01undeclared 0 · expected 2 (1 overdue)',
      'edge-02undeclared 0 · expected 0',
      'edge-03undeclared 1 · expected 0',
    ]);
  });

  it('renders nothing when absent', async () => {
    const fn = mockFetch(404);
    const { container } = render(<ArrivalsSummary />);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('shows a muted line on error', async () => {
    mockFetch(500);
    render(<ArrivalsSummary />);
    expect(await screen.findByText('Arrivals summary unavailable')).toBeTruthy();
  });

  it('shows the empty line when no edges report', async () => {
    mockFetch(200, { edges: [] });
    render(<ArrivalsSummary />);
    expect(await screen.findByText('No edges reporting')).toBeTruthy();
  });

  it('marks undeclared and overdue rows amber, and a zero row not', async () => {
    mockFetch(200, { edges: EDGES });
    render(<ArrivalsSummary />);
    await waitFor(() => expect(screen.getAllByTestId('arrivals-summary-row')).toHaveLength(3));
    const [overdue, zero, undeclared] = screen.getAllByTestId('arrivals-summary-row');
    expect(overdue.className).toContain('text-amber-400');
    expect(undeclared.className).toContain('text-amber-400');
    expect(zero.className).not.toContain('text-amber-400');
  });

  it('refreshes on an interval and stops on unmount', async () => {
    vi.useFakeTimers();
    try {
      const fn = mockFetch(200, { edges: EDGES });
      const { unmount } = render(<ArrivalsSummary />);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fn).toHaveBeenCalledTimes(2);
      unmount();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A source-text check, the same approach as linkControlWiring.test.ts: HqApp
  // pulls in the whole data layer, so it is not mounted here.
  it('is mounted in HqApp directly after RegionFleetSummary', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'HqApp.tsx'), 'utf8');
    expect(src).toMatch(/<RegionFleetSummary \/>\s*<ArrivalsSummary \/>/);
  });
});
