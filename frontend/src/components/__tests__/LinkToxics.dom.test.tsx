// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChildLinkRow } from '../LinkToggle';

const ZERO = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };

function mount(onToxics: (t: typeof ZERO) => void) {
  render(
    <ChildLinkRow
      id="edge-01"
      row={undefined}
      status="ready"
      enabled={true}
      parent="this hub"
      onChange={() => {}}
      toxics={ZERO}
      onToxics={onToxics}
    />,
  );
}

function type(id: string, value: string) {
  fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
}

describe('ChildLinkRow toxics', () => {
  afterEach(cleanup);

  it('typing 2000 into latency and clicking SET applies {2000,0,0}', () => {
    const onToxics = vi.fn();
    mount(onToxics);
    type('link-toxics-edge-01-latency', '2000');
    fireEvent.click(screen.getByText('SET'));
    expect(onToxics).toHaveBeenCalledTimes(1);
    expect(onToxics).toHaveBeenCalledWith({ latency_ms: 2000, jitter_ms: 0, bandwidth_kb_s: 0 });
  });

  it('a negative value is not sent and the field is marked', () => {
    const onToxics = vi.fn();
    mount(onToxics);
    type('link-toxics-edge-01-latency', '-5');
    fireEvent.click(screen.getByText('SET'));
    expect(onToxics).not.toHaveBeenCalled();
    expect(document.getElementById('link-toxics-edge-01-latency')?.className).toContain('border-rose-500');
  });

  it('an out-of-range value is not sent', () => {
    const onToxics = vi.fn();
    mount(onToxics);
    type('link-toxics-edge-01-jitter', '60001');
    fireEvent.click(screen.getByText('SET'));
    expect(onToxics).not.toHaveBeenCalled();
  });

  it('CLR applies all zeros', () => {
    const onToxics = vi.fn();
    mount(onToxics);
    fireEvent.click(screen.getByText('CLR'));
    expect(onToxics).toHaveBeenCalledWith(ZERO);
  });
});
