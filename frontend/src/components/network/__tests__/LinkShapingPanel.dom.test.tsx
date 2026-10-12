// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinkShapingPanel } from '../LinkShapingPanel';
import type { LinkControlStatus, LinkToxics } from '../../../lib/linkControl';

const ZERO: LinkToxics = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };

function setup(over: { toxics?: LinkToxics | null; enabled?: boolean | null; status?: LinkControlStatus } = {}) {
  const onApply = vi.fn();
  const onSetEnabled = vi.fn();
  render(
    <LinkShapingPanel
      id="lk"
      toxics={over.toxics === undefined ? ZERO : over.toxics}
      enabled={over.enabled === undefined ? true : over.enabled}
      status={over.status ?? 'ready'}
      onApply={onApply}
      onSetEnabled={onSetEnabled}
    />,
  );
  return { onApply, onSetEnabled };
}
const tile = (name: string) => document.querySelector(`[data-preset="${name}"]`) as HTMLElement;
const btn = (name: string) => screen.getByRole('button', { name });

afterEach(cleanup);

describe('LinkShapingPanel', () => {
  it('a tile selects the draft only; APPLY commits the full state', () => {
    const { onApply, onSetEnabled } = setup();
    fireEvent.click(tile('CONTESTED'));
    expect(tile('CONTESTED').getAttribute('aria-checked')).toBe('true');
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId('shaping-state').textContent).toContain('Unsaved');
    fireEvent.click(btn('APPLY'));
    expect(onApply).toHaveBeenCalledWith({ latency_ms: 300, jitter_ms: 80, bandwidth_kb_s: 256 });
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it('a slider change shows CUSTOM and deselects every tile', () => {
    setup();
    expect(screen.queryByTestId('profile-custom')).toBeNull();
    fireEvent.change(document.getElementById('lk-latency')!, { target: { value: '500' } });
    expect(screen.getByTestId('profile-custom')).not.toBeNull();
    for (const n of ['NOMINAL', 'CONTESTED', 'DEGRADED', 'SEVERED']) {
      expect(tile(n).getAttribute('aria-checked')).toBe('false');
    }
  });

  it('CLEAR sends zeros immediately', () => {
    const { onApply } = setup({ toxics: { latency_ms: 300, jitter_ms: 80, bandwidth_kb_s: 256 } });
    fireEvent.click(btn('CLEAR'));
    expect(onApply).toHaveBeenCalledWith(ZERO);
  });

  it('SEVERED + APPLY switches the link off', () => {
    const { onApply, onSetEnabled } = setup();
    fireEvent.click(tile('SEVERED'));
    fireEvent.click(btn('APPLY'));
    expect(onSetEnabled).toHaveBeenCalledWith(false);
    expect(onApply).toHaveBeenCalledWith(ZERO);
  });

  it('forbidden: controls disabled; nothing is sent', () => {
    const { onApply, onSetEnabled } = setup({ status: 'forbidden' });
    expect((btn('APPLY') as HTMLButtonElement).disabled).toBe(true);
    expect((tile('NOMINAL') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn('APPLY'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it('the packet slicer is disabled, tagged, and never sends', () => {
    const { onApply } = setup();
    const sw = screen.getByRole('switch', { name: 'Packet slicer' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(document.body.textContent).toContain('NOT IN PEP YET');
    fireEvent.click(sw);
    fireEvent.click(btn('APPLY'));
    expect(onApply).toHaveBeenCalledWith(ZERO);
  });
});
