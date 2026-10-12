// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import NetworkPopover from '../NetworkPopover';
import { LinkRow } from '../LinkRow';

afterEach(cleanup);

function ui() {
  return (
    <div>
      <button data-testid="outside">outside</button>
      <NetworkPopover tone="ok" count="12" unit="MSGS">
        <LinkRow
          linkKey="a" toxicsId="a-tox" toggleId="a-toggle" from="a" to="b"
          status="ready" enabled toggleFrom="a" toggleTo="b" onToggle={() => {}}
          toxics={{ latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 }} onToxics={() => {}}
          observed={{ word: 'UP', className: '', tone: 'ok' }}
        />
      </NetworkPopover>
    </div>
  );
}
const pill = () => screen.getByTestId('network-pill');

describe('NetworkPopover', () => {
  it('pill toggles the dialog and reports aria state', () => {
    render(ui());
    expect(pill().getAttribute('aria-haspopup')).toBe('dialog');
    expect(pill().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(pill());
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('Escape collapses an expanded row first, then closes and refocuses the pill', () => {
    render(ui());
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'a to b' }));
    expect(screen.queryByTestId('link-shaping-panel')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('link-shaping-panel')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it('an outside mousedown closes; an inside one does not', () => {
    render(ui());
    fireEvent.click(pill());
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('operating the toggle does not expand the row', () => {
    render(ui());
    fireEvent.click(pill());
    fireEvent.click(document.getElementById('a-toggle')!);
    expect(screen.queryByTestId('link-shaping-panel')).toBeNull();
  });
});
