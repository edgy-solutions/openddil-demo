// Test helper: render a header in jsdom, open its network popover by clicking
// the pill, and return the resulting markup so the existing string assertions
// keep working. Clicks every row caret too when `expandRows` is set, so slider
// ids are present.
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

export function renderOpen(el: ReactElement, opts: { expandRows?: boolean } = {}): string {
  cleanup();
  const { container, getByTestId } = render(el);
  fireEvent.click(getByTestId('network-pill'));
  if (opts.expandRows) {
    // Expanding one row collapses the previous, so snapshot each in turn.
    const chunks: string[] = [];
    const rows = Array.from(container.querySelectorAll<HTMLElement>('button[aria-expanded]'))
      .filter((b) => b.getAttribute('aria-label')?.includes(' to '));
    for (const b of rows) {
      fireEvent.click(b);
      chunks.push(container.innerHTML);
    }
    return container.innerHTML + chunks.join('\n');
  }
  return container.innerHTML;
}
