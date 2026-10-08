// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SubtreeScopeLabel } from '../SubtreeScopeLabel';

describe('SubtreeScopeLabel', () => {
  afterEach(cleanup);

  it('names the child tiers and renders no selector', () => {
    const { container } = render(
      <SubtreeScopeLabel tiers={['edge-01', 'edge-02']} emptyText="none yet" />,
    );
    expect(screen.getByTestId('scope-label').textContent).toBe('edge-01 · edge-02');
    expect(container.querySelector('select')).toBeNull();
  });

  it('shows the empty text when no child tiers are observed', () => {
    render(<SubtreeScopeLabel tiers={[]} emptyText="none yet" />);
    expect(screen.getByTestId('scope-label').textContent).toBe('none yet');
  });
});
