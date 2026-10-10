// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../hooks', () => ({
  useAllCmState: () => ({ data: [], isLoading: false, isError: false }),
  useEdgeBuffer: () => ({ status: { hq_link_severed: true } }),
}));

import WorkOrders from '../WorkOrders';

describe('severed overlay', () => {
  afterEach(cleanup);

  it('names the uplink, not a fixed far end', () => {
    render(<WorkOrders />);
    expect(screen.getByText('UPLINK SEVERED')).toBeTruthy();
  });
});
