// @vitest-environment jsdom
// Synthetic ids only. fetch and window.open are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FaultReportOverlay from '../FaultReportOverlay';
import ManualQuestionPanel from '../ManualQuestionPanel';
import { ReleasedRecordsView } from '../releasability/ReleasedRecordsPane';
import { __setCortexForTest, parseCortex } from '../../deployment';
import type { DecisionRecord, DecisionsResponse } from '../../hooks/useEgressAdmission';

const BASE = 'https://cortex.example.test';

function row(over: Record<string, unknown> = {}) {
  return {
    route: 'r1', case_id: 'case-1', episode_id: 'ep-1', event_id: 'evt-1', asset_id: 'asset-a',
    component: 'comp-1', fault_code: 'F-1', delivered_at: '2026-10-17T10:00:00Z', ...over,
  };
}

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn<(...args: unknown[]) => Promise<Response>>(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const ok = (cases: unknown[]) => async () => new Response(JSON.stringify({ cases }), { status: 200 });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  __setCortexForTest(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('B1 parseCortex', () => {
  it('accepts http(s) and strips trailing slashes', () => {
    expect(parseCortex({ baseUrl: BASE })).toEqual({ baseUrl: BASE });
    expect(parseCortex({ baseUrl: `${BASE}/` })).toEqual({ baseUrl: BASE });
  });
  it('treats a bad scheme as absent, with one warn', () => {
    expect(parseCortex({ baseUrl: 'ftp://cortex.example.test' })).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
  it('absent is absent, silently', () => {
    expect(parseCortex(undefined)).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('B2 Approve in cortex', () => {
  const faults = [{ component: 'comp-1', faultCode: 'F-1' }];
  const overlay = <FaultReportOverlay assetId="asset-a" components={[]} bit={null} faults={faults} />;

  it('draws the link from case_id, encoded', async () => {
    __setCortexForTest(BASE);
    const fn = stubFetch(ok([row({ case_id: 'case 1/x', event_id: 'evt-9' })]));
    render(overlay);
    const a = await screen.findByText('Approve in cortex');
    const link = a.closest('a')!;
    expect(link.getAttribute('href')).toBe(`${BASE}/case/case%201%2Fx`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(String(fn.mock.calls[0][0])).toBe('/egress/cases?asset_id=asset-a');
  });

  it('uses the newest delivered_at when several match', async () => {
    __setCortexForTest(BASE);
    stubFetch(ok([row({ case_id: 'old' }), row({ case_id: 'new', delivered_at: '2026-10-17T11:00:00Z' })]));
    render(overlay);
    const a = await screen.findByText('Approve in cortex');
    expect(a.closest('a')!.getAttribute('href')).toBe(`${BASE}/case/new`);
  });

  it('no match draws no link', async () => {
    __setCortexForTest(BASE);
    const fn = stubFetch(ok([row({ fault_code: 'F-2' })]));
    render(overlay);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Approve in cortex')).toBeNull();
  });

  it('a fetch rejection draws no link and warns once', async () => {
    __setCortexForTest(BASE);
    const fn = stubFetch(async () => { throw new Error('down'); });
    render(overlay);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Approve in cortex')).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('cortex absent: no fetch at all', async () => {
    const fn = stubFetch(ok([row()]));
    render(overlay);
    await act(async () => {});
    expect(fn).not.toHaveBeenCalled();
    expect(screen.queryByText('Approve in cortex')).toBeNull();
  });
});

describe('C1 idp marker', () => {
  const faults = [{ component: 'comp-1', faultCode: 'F-1' }];
  const overlay = <FaultReportOverlay assetId="asset-a" components={[]} bit={null} faults={faults} />;
  const type = (text: string) =>
    fireEvent.change(screen.getByPlaceholderText(/Ask about this asset/), { target: { value: text } });
  const panel = <ManualQuestionPanel assetId="asset-a" platformVariant="v" scope={['dmc-1']} />;

  it('parseCortex keeps a valid idp, drops an invalid one with one warn', () => {
    expect(parseCortex({ baseUrl: BASE, idp: 'example-idp' })).toEqual({ baseUrl: BASE, idp: 'example-idp' });
    expect(console.warn).not.toHaveBeenCalled();
    expect(parseCortex({ baseUrl: BASE, idp: 'Bad_IDP' })).toEqual({ baseUrl: BASE });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('idp set: both exact URLs carry it', async () => {
    __setCortexForTest(BASE, 'example-idp');
    stubFetch(ok([row()]));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { unmount } = render(overlay);
    const a = await screen.findByText('Approve in cortex');
    expect(a.closest('a')!.getAttribute('href')).toBe(`${BASE}/case/case-1?idp=example-idp`);
    unmount();
    render(panel);
    type('why & how?');
    fireEvent.click(screen.getByText('Ask in cortex'));
    expect(open).toHaveBeenCalledWith(
      `${BASE}/ask?q=why%20%26%20how%3F&idp=example-idp`, '_blank', 'noopener,noreferrer',
    );
  });

  it('idp absent: both exact URLs unchanged', async () => {
    __setCortexForTest(BASE);
    stubFetch(ok([row()]));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { unmount } = render(overlay);
    const a = await screen.findByText('Approve in cortex');
    expect(a.closest('a')!.getAttribute('href')).toBe(`${BASE}/case/case-1`);
    unmount();
    render(panel);
    type('why & how?');
    fireEvent.click(screen.getByText('Ask in cortex'));
    expect(open).toHaveBeenCalledWith(`${BASE}/ask?q=why%20%26%20how%3F`, '_blank', 'noopener,noreferrer');
  });

  it('invalid idp is dropped: links without it, one warn', async () => {
    const cfg = parseCortex({ baseUrl: BASE, idp: 'Bad_IDP' })!;
    __setCortexForTest(cfg.baseUrl, cfg.idp);
    stubFetch(ok([row()]));
    render(overlay);
    const a = await screen.findByText('Approve in cortex');
    expect(a.closest('a')!.getAttribute('href')).toBe(`${BASE}/case/case-1`);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('513-char case id draws no link (one warn across polls); 512 draws one', async () => {
    __setCortexForTest(BASE);
    stubFetch(ok([row({ case_id: 'a'.repeat(513) })]));
    const { rerender, unmount } = render(overlay);
    await act(async () => {});
    rerender(<FaultReportOverlay assetId="asset-a" components={[]} bit={null} faults={[...faults]} />);
    await act(async () => {});
    expect(screen.queryByText('Approve in cortex')).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    unmount();
    stubFetch(ok([row({ case_id: 'b'.repeat(512) })]));
    render(overlay);
    const a = await screen.findByText('Approve in cortex');
    expect(a.closest('a')!.getAttribute('href')).toBe(`${BASE}/case/${'b'.repeat(512)}`);
  });
});

describe('B3 question panel', () => {
  const panel = <ManualQuestionPanel assetId="asset-a" platformVariant="v" scope={['dmc-1']} />;
  const type = (text: string) =>
    fireEvent.change(screen.getByPlaceholderText(/Ask about this asset/), { target: { value: text } });

  it('configured: opens the cortex ask URL and does not call /manual/ask', () => {
    __setCortexForTest(BASE);
    const fetchFn = stubFetch(ok([]));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(panel);
    type('  why & how? ');
    fireEvent.click(screen.getByText('Ask in cortex'));
    expect(open).toHaveBeenCalledWith(
      `${BASE}/ask?q=${encodeURIComponent('why & how?')}`, '_blank', 'noopener,noreferrer',
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByText(/opens in cortex under your own sign-in/)).toBeTruthy();
  });

  it('4001 chars is refused, never truncated', () => {
    __setCortexForTest(BASE);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(panel);
    type('x'.repeat(4001));
    const btn = screen.getByText('Ask in cortex').closest('button')!;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/4001 of 4000/);
  });

  it('4000 chars goes through whole', () => {
    __setCortexForTest(BASE);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(panel);
    type('x'.repeat(4000));
    fireEvent.click(screen.getByText('Ask in cortex'));
    expect(open).toHaveBeenCalledWith(`${BASE}/ask?q=${'x'.repeat(4000)}`, '_blank', 'noopener,noreferrer');
  });

  it('absent: posts to /manual/ask as today', async () => {
    const fn = stubFetch(async () => new Response(JSON.stringify({}), { status: 404 }));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(panel);
    type('a question');
    fireEvent.click(screen.getByText('Ask'));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(String(fn.mock.calls[0][0])).toMatch(/manual\/ask/);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('B4 approval chain on the pane', () => {
  function rec(body: Record<string, unknown>, allowed = true): DecisionRecord {
    return {
      asset_id: null, originator_nation: null, releasable_to: [], allowed,
      reason: allowed ? null : 'label_mismatch', decision_id: 'dec-1', key: 'k-1',
      owning_tier: 'edge-01', decided_at: '2026-10-17T00:00:00Z', body,
    };
  }
  const view = (r: DecisionRecord) => {
    const data = {
      records: [r], admitted: r.allowed ? 1 : 0, policy_version: 'p', corpus_version: 'c',
    } as DecisionsResponse;
    return render(<ReleasedRecordsView data={data} columns={[]} />);
  };
  const step = (n: number, role: string, sub: string, decision = 'approved') => ({
    step: n, role, approver_sub: sub, decision, decided_at: `2026-10-17T0${n}:00:00Z`,
  });

  it('renders out-of-order steps in step order with all five fields', () => {
    view(rec({
      approval_chain: [
        step(3, 'releaser', 'sub-releaser'), step(1, 'chooser', 'sub-chooser'),
        step(2, 'approver', 'sub-approver', 'rejected'),
      ],
    }));
    const lines = screen.getAllByTestId('approval-chain-step').map((l) => l.textContent);
    expect(lines).toEqual([
      '1 · chooser · sub-chooser · approved · 2026-10-17T01:00:00Z',
      '2 · approver · sub-approver · rejected · 2026-10-17T02:00:00Z',
      '3 · releaser · sub-releaser · approved · 2026-10-17T03:00:00Z',
    ]);
    expect(screen.queryByTestId('approval-chain-unreadable')).toBeNull();
  });

  it('shows the chain on a refused row too', () => {
    view(rec({ approval_chain: [step(1, 'chooser', 'sub-chooser')] }, false));
    expect(screen.getAllByTestId('approval-chain-step')).toHaveLength(1);
  });

  it('skips a malformed entry and says so', () => {
    view(rec({
      approval_chain: [step(1, 'chooser', 'sub-chooser'), { step: 'x' }, step(2, 'approver', 'sub-approver')],
    }));
    expect(screen.getAllByTestId('approval-chain-step')).toHaveLength(2);
    expect(screen.getByTestId('approval-chain-unreadable').textContent).toBe('1 entry unreadable');
  });

  it('no chain, nothing extra', () => {
    view(rec({}));
    expect(screen.queryByTestId('approval-chain')).toBeNull();
    cleanup();
    view(rec({ approval_chain: [] }));
    expect(screen.queryByTestId('approval-chain')).toBeNull();
  });
});
