// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
vi.mock('../ManualQuestionPanel', () => ({
  default: () => <div data-testid="manual-panel">manual panel</div>,
}));

import FaultReportOverlay from '../FaultReportOverlay';
import ManualOverlay from '../ManualOverlay';

afterEach(cleanup);

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
});
