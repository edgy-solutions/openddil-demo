// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import CmStateCard, { cmStatusBadge } from '../CmStateCard';
import type { CmState } from '../../hooks';

describe('cmStatusBadge', () => {
  it('maps the stored tokens to status accounting words', () => {
    expect(cmStatusBadge('CONFIG_STATUS_IN_COMPLIANCE').label).toBe('CONFORMS');
    expect(cmStatusBadge('CONFIG_STATUS_MINOR_DISCREPANCY').label).toBe('DEVIATES');
    expect(cmStatusBadge('CONFIG_STATUS_MAJOR_DISCREPANCY').label).toBe('DEVIATES: MAJOR');
    expect(cmStatusBadge('CONFIG_STATUS_NOT_MISSION_CAPABLE').label).toBe('DEVIATES: CRITICAL');
  });

  it('colours a critical discrepancy red and a minor one amber', () => {
    expect(cmStatusBadge('CONFIG_STATUS_NOT_MISSION_CAPABLE').cls).toContain('rose');
    expect(cmStatusBadge('CONFIG_STATUS_MINOR_DISCREPANCY').cls).toContain('amber');
  });

  it('splits "no state" by whether a baseline is declared', () => {
    expect(cmStatusBadge(undefined).label).toBe('NO BASELINE DECLARED');
    expect(cmStatusBadge('CONFIG_STATUS_UNSPECIFIED', false).label).toBe('NO BASELINE DECLARED');
    expect(cmStatusBadge('CONFIG_STATUS_UNSPECIFIED', true).label).toBe('NO CONFIGURATION DATA');
  });
});

describe('CmStateCard', () => {
  afterEach(cleanup);

  const row = (over: Record<string, unknown>) => ({
    asset_id: 'asset-1',
    overall_status: 'CONFIG_STATUS_UNSPECIFIED',
    lifecycle: 'LIFECYCLE_ACTIVE',
    baseline_id: null,
    installed: [],
    mod_status: [],
    discrepancies: [],
    manual_discrepancies: [],
    ...over,
  }) as unknown as CmState;

  it('titles the card and names the baseline as subtitle', () => {
    render(<CmStateCard cm={row({ baseline_id: 'BL-7', overall_status: 'CONFIG_STATUS_IN_COMPLIANCE' })} />);
    expect(screen.getByText('Configuration status')).toBeTruthy();
    expect(screen.getByTestId('cm-baseline').textContent).toBe('BL-7');
    expect(screen.getByTestId('cm-badge').textContent).toBe('CONFORMS');
  });

  it('shows no configuration data for a baseline with no assessment', () => {
    render(<CmStateCard cm={row({ baseline_id: 'BL-7' })} />);
    expect(screen.getByTestId('cm-badge').textContent).toBe('NO CONFIGURATION DATA');
  });

  it('shows no baseline declared, and no subtitle, without a baseline', () => {
    render(<CmStateCard cm={row({})} />);
    expect(screen.getByTestId('cm-badge').textContent).toBe('NO BASELINE DECLARED');
    expect(screen.queryByTestId('cm-baseline')).toBeNull();
  });
});
