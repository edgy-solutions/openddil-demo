// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The real form fetches a catalog; a stub that echoes its props is enough to
// prove the overlay opens/closes it and threads the prefill through.
vi.mock('../FaultReportForm', () => ({
  default: (p: { prefillComponent?: string; prefillCode?: string; onClose?: () => void }) => (
    <div data-testid="form">
      form:{p.prefillComponent ?? '-'}:{p.prefillCode ?? '-'}
      <button type="button" onClick={p.onClose}>Close</button>
    </div>
  ),
}));
// A stub by default; the 404 test switches to the real panel.
const useReal = vi.hoisted(() => ({ on: false }));
vi.mock('../ManualQuestionPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ManualQuestionPanel')>();
  return {
    default: (p: React.ComponentProps<typeof actual.default>) =>
      useReal.on ? <actual.default {...p} /> : <div data-testid="manual-panel">manual panel</div>,
  };
});

import FaultReportOverlay from '../FaultReportOverlay';
import ManualOverlay from '../ManualOverlay';

afterEach(() => { cleanup(); useReal.on = false; vi.unstubAllGlobals(); });

describe('FaultReportOverlay', () => {
  it('opens the form from the FAB and closes it with the close button or Escape', () => {
    render(<FaultReportOverlay assetId="a1" components={['FCS']} bit={null} />);
    expect(screen.queryByTestId('form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Report a fault' }));
    expect(screen.getByTestId('form').textContent).toContain('form:-:-');
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('form')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Report a fault' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('form')).toBeNull();
  });

  it('keeps the BIT card visible and its record action opens the form prefilled', () => {
    render(
      <FaultReportOverlay
        assetId="a1"
        components={['FCS']}
        bit={{ key: 'FCS|FCS-214', component: 'FCS', faultCode: 'FCS-214', text: 'Ballistic computer BIT fail' }}
      />,
    );
    expect(screen.getByText('Ballistic computer BIT fail')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /record/i }));
    expect(screen.getByTestId('form').textContent).toContain('form:FCS:FCS-214');
    // Still visible with the sheet open.
    expect(screen.getByText('Ballistic computer BIT fail')).toBeTruthy();
  });
});

describe('FaultReportOverlay resolve', () => {
  const faults = [{ component: 'ENG-1', faultCode: 'FC-100' }];
  const stubFetch = (status: number, body: unknown) => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/cm/discrepancy/resolve')) {
        return { ok: status < 300, status, statusText: '', json: async () => body } as Response;
      }
      return { ok: false, status: 404, statusText: '', json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', f);
    return f;
  };
  const resolveCalls = (f: ReturnType<typeof stubFetch>) =>
    f.mock.calls.filter((c) => String(c[0]).includes('/cm/discrepancy/resolve'));

  it('draws no Resolve button when mayResolve is false or absent', () => {
    stubFetch(202, {});
    render(<FaultReportOverlay assetId="a1" components={[]} bit={null} faults={faults} />);
    expect(screen.queryByRole('button', { name: 'Resolve FC-100' })).toBeNull();
    cleanup();
    render(<FaultReportOverlay assetId="a1" components={[]} bit={null} faults={faults} mayResolve={false} />);
    expect(screen.queryByRole('button', { name: 'Resolve FC-100' })).toBeNull();
  });

  it('opens a form, refuses an empty resolution, then POSTs the exact body and reads sent', async () => {
    const f = stubFetch(202, { event_id: 'e1' });
    render(<FaultReportOverlay assetId="a1" components={[]} bit={null} faults={faults} mayResolve />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve FC-100' }));
    const submit = screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(resolveCalls(f)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: 'replaced the seal' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText('Resolve sent, awaiting CM')).toBeTruthy());
    const calls = resolveCalls(f);
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      asset_id: 'a1', component: 'ENG-1', fault_code: 'FC-100', resolution: 'replaced the seal',
    });
  });

  it('shows the role message on 403 and keeps the form open', async () => {
    stubFetch(403, { error: 'forbidden' });
    render(<FaultReportOverlay assetId="a1" components={[]} bit={null} faults={faults} mayResolve />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve FC-100' }));
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(screen.getByText('Your role may not resolve a fault at this tier.')).toBeTruthy());
    expect(screen.getByLabelText('Resolution')).toBeTruthy();
  });

  it('Cancel closes the form without a request', () => {
    const f = stubFetch(202, {});
    render(<FaultReportOverlay assetId="a1" components={[]} bit={null} faults={faults} mayResolve />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve FC-100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(resolveCalls(f)).toHaveLength(0);
  });
});

describe('ManualOverlay', () => {
  it('keeps the panel mounted but hidden until the button opens it, and renders the slot', () => {
    render(
      <ManualOverlay
        assetId="a1"
        platformVariant="M1A2"
        scope={['dmc1']}
        bottomLeftSlot={<div data-testid="radar">radar</div>}
      />,
    );
    expect(screen.getByTestId('radar')).toBeTruthy();
    const region = screen.getByTestId('manual-panel').closest('[role="region"]') as HTMLElement;
    expect(region.hidden).toBe(true);
    const btn = screen.getByRole('button', { name: 'Ask the manual' });
    fireEvent.click(btn);
    expect(region.hidden).toBe(false);
    fireEvent.click(btn);
    expect(region.hidden).toBe(true);
  });

  it('a 404 on ask shows "Manual service unavailable" and relabels the button', async () => {
    useReal.on = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    render(<ManualOverlay assetId="a1" platformVariant="M1A2" scope={['dmc1']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask the manual' }));
    fireEvent.change(screen.getByPlaceholderText(/fault isolation/), { target: { value: 'why?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Ask$/ }));
    const btn = await screen.findByRole('button', { name: 'Manual service unavailable' });
    const region = screen.getByRole('region', { name: 'Ask the manual' });
    expect(region.textContent).toContain('Manual service unavailable');
    expect(btn.getAttribute('title')).toBe('Manual service unavailable');
  });
});
