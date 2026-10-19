// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NationLegend from '../releasability/NationLegend';

afterEach(cleanup);

const registry = [{ code: 'ATL', name: 'Atlantia', color: '#60a5fa' }];
const atl = { originator_nation: 'ATL', releasable_to: [] };

describe('NationLegend', () => {
  it('with a title, renders a labelled block holding the keys', () => {
    render(<NationLegend assets={[atl]} registry={registry} title="NATIONS" />);
    const block = screen.getByTestId('nation-legend');
    expect(block.textContent).toContain('NATIONS');
    expect(block.textContent).toContain('ATL');
  });

  it('without a title, renders the bare keys', () => {
    render(<NationLegend assets={[atl]} registry={registry} />);
    expect(screen.queryByTestId('nation-legend')).toBeNull();
    expect(screen.getByText('ATL')).toBeTruthy();
  });

  it('with no assets on screen, renders nothing, label included', () => {
    const { container } = render(
      <NationLegend assets={[]} registry={registry} title="NATIONS" />,
    );
    expect(container.textContent).toBe('');
  });
});
