// @vitest-environment jsdom
// Synthetic ids only. fetch is stubbed. ADR-0058 slice 3a.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import ReportsPane from '../ReportsPane';
import FaultReportOverlay from '../FaultReportOverlay';
import { __setCortexForTest } from '../../deployment';

const STATE_NAMES = [
  'filed', 'queued for send', 'sent', 'case opened', 'proposed', 'approved', 'released',
  'work recorded', 'work recorded: cancelled', 'work recorded: deferred',
  'door at the hub, unreachable', 'door not configured at this tier', 'sent, awaiting reply',
  'a state name from a later server',
];

function report(over: Record<string, unknown> = {}) {
  return {
    episode_id: 'ep-1', detected_at: '2026-11-21T10:00:00Z', asset_id: 'asset-a',
    component: 'comp-1', fault_code: 'F-1', open: true, cleared_at: null, cleared_by: null,
    resolution: null,
    states: [{ state: 'filed', source: 'openddil', at: '2026-11-21T10:00:00Z', detail: {} }],
    unmatched: [], ...over,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stubRoutes(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (url: unknown) => {
    const h = routes[String(url)];
    return h ? h() : json({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  __setCortexForTest(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('My reports', () => {
  it('renders every state name with its source and time, and no aggregate status', async () => {
    const states = STATE_NAMES.map((state, i) => ({
      state, source: `src-${i}`, at: i % 2 ? '2026-11-21T10:05:00Z' : null,
      detail: state === 'queued for send' ? { held: 'retries exhausted' } : {},
    }));
    stubRoutes({ '/reports/mine': () => json({ reports: [report({ states })], unmatched_ledger: [] }) });
    const { container } = render(<ReportsPane role="maintainer" />);
    await waitFor(() => expect(screen.getAllByTestId('report-state-row')).toHaveLength(STATE_NAMES.length));
    const rows = screen.getAllByTestId('report-state-row');
    STATE_NAMES.forEach((name, i) => {
      expect(rows[i].textContent).toContain(name);
      expect(rows[i].textContent).toContain(`source src-${i}`);
    });
    expect(rows[0].textContent).toContain('no time');
    expect(rows[1].textContent).not.toContain('no time');
    expect(rows[1].textContent).toContain('retries exhausted');
    // No combined status: no status role, no badge, one list per report.
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[class*="badge"]')).toBeNull();
    expect(screen.getAllByTestId('report-item')).toHaveLength(1);
  });

  it('keeps the order the server sent', async () => {
    const states = [
      { state: 'sent', source: 'openddil', at: null, detail: {} },
      { state: 'filed', source: 'openddil', at: null, detail: {} },
    ];
    stubRoutes({ '/reports/mine': () => json({ reports: [report({ states })] }) });
    render(<ReportsPane />);
    await waitFor(() => screen.getAllByTestId('report-state-row'));
    const rows = screen.getAllByTestId('report-state-row').map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('sent');
    expect(rows[1]).toContain('filed');
  });

  it('shows the server state text when the list is empty', async () => {
    stubRoutes({ '/reports/mine': () => json({ reports: [], unmatched_ledger: [], state: 'no reports filed by you' }) });
    render(<ReportsPane />);
    expect(await screen.findByText('no reports filed by you')).toBeTruthy();
  });

  it('closed episode shows cleared_at, cleared_by and resolution', async () => {
    const closed = report({ open: false, cleared_at: '2026-11-21T12:00:00Z', cleared_by: 'person-x', resolution: 'part replaced' });
    stubRoutes({ '/reports/mine': () => json({ reports: [closed] }) });
    render(<ReportsPane />);
    const el = await screen.findByTestId('report-closed');
    expect(el.textContent).toContain('person-x');
    expect(el.textContent).toContain('part replaced');
  });

  it('door unreachable is a named state beside filed, not a banner', async () => {
    const states = [
      { state: 'filed', source: 'openddil', at: '2026-11-21T10:00:00Z', detail: {} },
      { state: 'door at the hub, unreachable', source: 'openddil', at: null, detail: {} },
    ];
    stubRoutes({ '/reports/mine': () => json({ reports: [report({ states })] }) });
    render(<ReportsPane />);
    await waitFor(() => expect(screen.getAllByTestId('report-state-row')).toHaveLength(2));
    const text = screen.getAllByTestId('report-state-row').map((r) => r.textContent).join('|');
    expect(text).toContain('filed');
    expect(text).toContain('door at the hub, unreachable');
    expect(screen.queryByText(/fetch failed/)).toBeNull();
  });

  it('lists unmatched ledger rows and per-report unmatched items', async () => {
    stubRoutes({
      '/reports/mine': () => json({
        reports: [report({ unmatched: ['episode mismatch: ep-9'] })],
        unmatched_ledger: [{ event_id: 'evt-orphan' }],
      }),
    });
    render(<ReportsPane />);
    const per = await screen.findByTestId('report-unmatched');
    expect(per.textContent).toContain('unmatched');
    expect(per.textContent).toContain('episode mismatch');
    const led = screen.getByTestId('ledger-unmatched');
    expect(led.textContent).toContain('unmatched');
    expect(led.textContent).toContain('evt-orphan');
  });
});

describe('Reports at this tier', () => {
  it('a supervisor gets the tier timeline from /reports/tier', async () => {
    const fn = stubRoutes({
      '/reports/mine': () => json({ reports: [], state: 'no reports filed by you' }),
      '/reports/tier': () => json({ reports: [report({ episode_id: 'ep-tier' })] }),
    });
    render(<ReportsPane role="supervisor" />);
    expect(await screen.findByText(/ep-tier/)).toBeTruthy();
    expect(fn).toHaveBeenCalledWith('/reports/tier');
  });

  it('a non-supervisor role does not fetch or render the tier panel', async () => {
    const fn = stubRoutes({ '/reports/mine': () => json({ reports: [], state: 'no reports filed by you' }) });
    render(<ReportsPane role="maintainer" />);
    await screen.findByText('no reports filed by you');
    expect(fn).not.toHaveBeenCalledWith('/reports/tier');
    expect(screen.queryByLabelText('Reports at this tier')).toBeNull();
  });

  it('a 403 shows the body state text', async () => {
    stubRoutes({
      '/reports/mine': () => json({ reports: [report()] }),
      '/reports/tier': () => json({ error: 'forbidden', state: 'reports at this tier are for a supervisor' }, 403),
    });
    render(<ReportsPane role="supervisor" />);
    expect(await screen.findByText('reports at this tier are for a supervisor')).toBeTruthy();
    // The viewer's own reports are still drawn.
    expect(screen.getAllByTestId('report-item')).toHaveLength(1);
  });
});

describe('disposition on the asset card', () => {
  const BASE = 'https://cortex.example.test';
  function caseRow(over: Record<string, unknown> = {}) {
    return {
      route: 'r1', case_id: 'case-1', episode_id: 'ep-1', event_id: 'evt-1', asset_id: 'asset-a',
      component: 'comp-1', fault_code: 'F-1', delivered_at: '2026-11-21T10:00:00Z', ...over,
    };
  }
  async function draw(row: Record<string, unknown>) {
    __setCortexForTest(BASE);
    stubRoutes({ '/egress/cases?asset_id=asset-a': () => json({ cases: [row] }) });
    render(
      <FaultReportOverlay
        assetId="asset-a"
        components={[]}
        bit={null}
        faults={[{ component: 'comp-1', faultCode: 'F-1' } as never]}
      />,
    );
    await screen.findByText('Open maintenance case');
  }

  it('admitted: option, stage, producer case id and time', async () => {
    await draw(caseRow({
      disposition_state: 'admitted', disposition: { option: 'opt-a', stage: 'stage-b' },
      decided_at: '2026-11-21T11:00:00Z', decision: { allowed: true, reason: null },
    }));
    const t = (await screen.findByTestId('case-disposition')).textContent ?? '';
    expect(t).toContain('opt-a');
    expect(t).toContain('stage-b');
    expect(t).toContain('case-1');
    expect(t).not.toContain('no time');
  });

  it('refused: says refused with the reason', async () => {
    await draw(caseRow({
      disposition_state: 'refused', disposition: null, decided_at: '2026-11-21T11:00:00Z',
      decision: { allowed: false, reason: 'schema_invalid' },
    }));
    const t = (await screen.findByTestId('case-disposition')).textContent ?? '';
    expect(t).toContain('refused');
    expect(t).toContain('schema_invalid');
  });

  it.each([
    ['none', 'no disposition recorded'],
    ['unjoinable', 'action kind declares no case reference'],
    ['held at the hub', 'disposition held at the hub'],
  ])('%s names itself', async (state, text) => {
    await draw(caseRow({ disposition_state: state, disposition: null, decided_at: null, decision: null }));
    expect((await screen.findByTestId('case-disposition')).textContent).toBe(text);
  });

  it('an old-shape case draws no disposition and keeps the link', async () => {
    await draw(caseRow());
    expect(screen.queryByTestId('case-disposition')).toBeNull();
    expect(screen.getByText('Open maintenance case')).toBeTruthy();
  });
});
