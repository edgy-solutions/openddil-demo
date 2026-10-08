// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../hooks', () => ({
  useAllCmState: () => ({
    data: [{
      asset_id: 'asset-1',
      overall_status: 'CONFIG_STATUS_NOT_MISSION_CAPABLE',
      discrepancies: [{ discrepancy_id: 'd1', description: 'desc', recommended_action: 'Replace part' }],
      manual_discrepancies: [],
    }],
    isLoading: false,
    isError: false,
  }),
  useEdgeBuffer: () => ({ status: { hq_link_severed: false } }),
}));

import WorkOrders from '../WorkOrders';
import HqWorkOrders from '../../hq/HqWorkOrders';

describe('CM status chip', () => {
  afterEach(cleanup);

  it('regional panel keeps the chip on one line', () => {
    render(<WorkOrders />);
    expect(screen.getByText(/NON-COMPLIANT/).className).toContain('whitespace-nowrap');
  });

  it('HQ panel keeps the chip on one line', () => {
    render(<HqWorkOrders wanActive={true} />);
    expect(screen.getByText(/NON-COMPLIANT/).className).toContain('whitespace-nowrap');
  });
});
