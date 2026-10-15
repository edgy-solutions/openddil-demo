// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ArrivalsPanel from '../ArrivalsPanel';

const DATA = {
  edge_id: 'edge-01',
  undeclared: [
    {
      asset_id: 'dis:1:1:9001', first_seen: null, last_seen: '2026-01-01T00:00:00Z',
      platform_variant: 'VAR-A', position: { lat: 1.5, lon: 2.5 }, candidates: ['S-100'],
    },
    {
      asset_id: 'dis:1:1:9002', first_seen: null, last_seen: null,
      platform_variant: 'UNKNOWN', position: null, candidates: [],
    },
  ],
  expected: [
    { serial: 'S-100', platform_variant: 'VAR-A', unit: 'unit-a', owning_nation: 'ATL',
      releasable_to: ['BDR'], due_by: '2026-01-02T00:00:00Z', overdue: false },
    { serial: 'S-200', platform_variant: 'VAR-B', unit: 'unit-a', owning_nation: 'BDR',
      releasable_to: [], due_by: '2025-12-01T00:00:00Z', overdue: true },
  ],
  units: [{ id: 'unit-a', name: 'Unit A' }],
  nations: ['ATL', 'BDR', 'CRX'],
  declarable_nations: ['ATL', 'CRX'],
  baselines: { 'VAR-A': ['bl-1'] },
};

function mockFetch(opts: { get?: { status: number; body?: unknown }; post?: { status: number; body?: unknown } } = {}) {
  const get = opts.get ?? { status: 200, body: DATA };
  const post = opts.post ?? { status: 201, body: { declared: {}, baseline_assigned: false } };
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = init?.method === 'POST' ? post : get;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ArrivalsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([404, 403])('renders nothing on %i', async (status) => {
    const fn = mockFetch({ get: { status } });
    const { container } = render(<ArrivalsPanel edgeId="edge-01" />);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing with no edge', () => {
    const fn = mockFetch();
    const { container } = render(<ArrivalsPanel edgeId={null} />);
    expect(container.innerHTML).toBe('');
    expect(fn).not.toHaveBeenCalled();
  });

  it('shows counts, position and an unavailable line on 5xx', async () => {
    mockFetch();
    render(<ArrivalsPanel edgeId="edge-01" />);
    expect((await screen.findByTestId('arrivals-count')).textContent).toBe(
      'undeclared 2 · expected 2',
    );
    expect(screen.getByTestId('arrivals-undeclared-dis:1:1:9001').textContent).toContain('1.5000, 2.5000');
    cleanup();
    mockFetch({ get: { status: 503 } });
    render(<ArrivalsPanel edgeId="edge-01" />);
    expect((await screen.findByTestId('arrivals-panel')).textContent).toBe('Arrivals unavailable');
  });

  it('lists an overdue row with its badge', async () => {
    mockFetch();
    render(<ArrivalsPanel edgeId="edge-01" />);
    expect((await screen.findByTestId('arrivals-overdue-S-200')).textContent).toBe('OVERDUE');
    expect(screen.getByTestId('arrivals-expected-S-200')).toBeTruthy();
    expect(screen.queryByTestId('arrivals-overdue-S-100')).toBeNull();
  });

  it('offers confirm buttons only for candidates', async () => {
    mockFetch();
    render(<ArrivalsPanel edgeId="edge-01" />);
    await screen.findByTestId('arrivals-panel');
    expect(screen.getByTestId('arrivals-confirm-dis:1:1:9001-S-100')).toBeTruthy();
    expect(screen.getByTestId('arrivals-declare-dis:1:1:9002')).toBeTruthy();
    expect(screen.queryByTestId(/arrivals-confirm-dis:1:1:9002/)).toBeNull();
  });

  it('offers only declarable nations in the declare form', async () => {
    mockFetch();
    render(<ArrivalsPanel edgeId="edge-01" />);
    fireEvent.click(await screen.findByTestId('arrivals-declare-dis:1:1:9001'));
    const sel = screen.getByTestId('arrivals-nation') as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value).filter(Boolean)).toEqual(['ATL', 'CRX']);
    expect((screen.getByTestId('arrivals-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables a confirm whose nation is not declarable', async () => {
    mockFetch({ get: { status: 200, body: { ...DATA, declarable_nations: ['CRX'] } } });
    render(<ArrivalsPanel edgeId="edge-01" />);
    fireEvent.click(await screen.findByTestId('arrivals-confirm-dis:1:1:9001-S-100'));
    expect((screen.getByTestId('arrivals-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('arrivals-form').textContent).toContain(
      'your login is not entitled to declare ATL',
    );
  });

  it('shows a refusal reason and keeps the form open', async () => {
    mockFetch({ post: { status: 409, body: { error: 'arrival declaration refused', cause: 'serial is already correlated to an asset' } } });
    render(<ArrivalsPanel edgeId="edge-01" />);
    fireEvent.click(await screen.findByTestId('arrivals-confirm-dis:1:1:9001-S-100'));
    fireEvent.click(screen.getByTestId('arrivals-submit'));
    expect((await screen.findByTestId('arrivals-error')).textContent).toBe(
      'serial is already correlated to an asset',
    );
    expect(screen.getByTestId('arrivals-form')).toBeTruthy();
  });

  it('refetches and closes the form after a successful submit', async () => {
    const fn = mockFetch();
    render(<ArrivalsPanel edgeId="edge-01" />);
    fireEvent.click(await screen.findByTestId('arrivals-confirm-dis:1:1:9001-S-100'));
    const gets = () => fn.mock.calls.filter(([, i]) => i?.method !== 'POST').length;
    const before = gets();
    fireEvent.click(screen.getByTestId('arrivals-submit'));
    await waitFor(() => expect(gets()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId('arrivals-form')).toBeNull());
    const post = fn.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toMatchObject({
      source: 'expect-confirm', confirm_serial: 'S-100', serial: 'S-100', unit: 'unit-a',
      originator_nation: 'ATL', releasable_to: ['BDR'], baseline_id: null,
    });
  });
});

describe('ArrivalsPanel partial declaration', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a persistent warning, closes the form and refetches on a 502 partial', async () => {
    const fn = mockFetch({
      post: { status: 502, body: { declared: true, baseline_assigned: false, cause: 'cm intake down' } },
    });
    render(<ArrivalsPanel edgeId="edge-01" />);
    fireEvent.click(await screen.findByTestId('arrivals-confirm-dis:1:1:9001-S-100'));
    fireEvent.change(screen.getByDisplayValue('none'), { target: { value: 'bl-1' } });
    const gets = () => fn.mock.calls.filter(([, i]) => i?.method !== 'POST').length;
    const before = gets();
    fireEvent.click(screen.getByTestId('arrivals-submit'));
    await waitFor(() => expect(gets()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId('arrivals-form')).toBeNull());
    expect(screen.getByTestId('arrivals-warning').textContent).toContain(
      'dis:1:1:9001 declared; baseline bl-1 NOT assigned: cm intake down',
    );
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByTestId('arrivals-warning')).toBeNull();
  });
});
