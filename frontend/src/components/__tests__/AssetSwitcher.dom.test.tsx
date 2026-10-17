// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssetSwitcher from '../AssetSwitcher';
import type { ReactNode } from 'react';
import type { FleetAsset, FleetTierMap } from '../../hooks';
import type { AssetTier } from '../../lib/assetTier';

afterEach(cleanup);

function asset(id: string, variant: string | null, callsign: string | null = null): FleetAsset {
  return { asset_id: id, platform_variant: variant, callsign } as unknown as FleetAsset;
}

const FLEET = [
  asset('dis:1:1:1001', 'M1A2', 'ALPHA'),
  asset('dis:1:1:1002', 'MRAD_Sensor'),
  asset('dis:1:1:1003', 'M1A2'),
];
const TIERS: FleetTierMap = new Map<string, AssetTier>([
  ['dis:1:1:1001', 'ACTIVE'],
  ['dis:1:1:1002', 'LOST'],
  ['dis:1:1:1003', 'DEGRADED'],
]);

function setup(selected = 'dis:1:1:1001', fleet = FLEET) {
  const set = vi.fn();
  render(<AssetSwitcher fleet={fleet} fleetTiers={TIERS} selectedAsset={selected} setSelectedAsset={set} />);
  return set;
}

describe('AssetSwitcher', () => {
  it('shows the selected asset identity and variant, and no tier word when live', () => {
    setup();
    const ident = screen.getByTestId('asset-identity');
    expect(ident.textContent).toContain('dis:1:1:1001 — ALPHA');
    expect(ident.textContent).toContain('M1A2');
    expect(ident.textContent).not.toContain('LOST');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the tier word on the card when the selection is non-live', () => {
    setup('dis:1:1:1002');
    expect(screen.getByTestId('asset-identity').textContent).toContain('LOST');
  });

  it('opens from the button', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  describe('"/" shortcut', () => {
    it('pressed on document.body while closed: prevented, opens, focuses an empty filter', () => {
      setup();
      expect(screen.queryByRole('listbox')).toBeNull();
      const notPrevented = fireEvent.keyDown(document.body, { key: '/' });
      expect(notPrevented).toBe(false);
      expect(screen.getByRole('listbox')).toBeTruthy();
      const filter = screen.getByRole('combobox', { name: 'Filter assets' });
      expect(document.activeElement).toBe(filter);
      expect((filter as HTMLInputElement).value).toBe('');
    });

    it('pressed while a non-text control has focus: opens', () => {
      setup();
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      btn.focus();
      fireEvent.keyDown(btn, { key: '/' });
      expect(screen.getByRole('listbox')).toBeTruthy();
      btn.remove();
    });

    it.each(['input', 'textarea'] as const)('pressed in a %s: not prevented, does not open', (tag) => {
      setup();
      const el = document.createElement(tag);
      document.body.appendChild(el);
      el.focus();
      const notPrevented = fireEvent.keyDown(el, { key: '/' });
      expect(notPrevented).toBe(true);
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(screen.getByRole('button', { name: 'Switch asset' }).getAttribute('aria-expanded')).toBe('false');
      el.remove();
    });

    it.each([['Ctrl', { ctrlKey: true }], ['Meta', { metaKey: true }]])('%s+/ does not open', (_n, mod) => {
      setup();
      fireEvent.keyDown(document.body, { key: '/', ...mod });
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('marks the current asset selected and suffixes non-live ones', () => {
    setup('dis:1:1:1001');
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    const opts = screen.getAllByRole('option');
    expect(opts[0].getAttribute('aria-selected')).toBe('true');
    expect(opts[1].getAttribute('aria-selected')).toBe('false');
    expect(opts[1].textContent).toContain('LOST');
    expect(opts[0].textContent).not.toContain('LOST');
    expect(opts[2].textContent).not.toContain('DEGRADED');
  });

  it('filters by label, id and variant', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'mrad' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(screen.getAllByRole('option')[0].textContent).toContain('ALPHA');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('arrow keys move and Enter selects, closing the panel', () => {
    const set = setup('dis:1:1:1001');
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(set).toHaveBeenCalledWith('dis:1:1:1002');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking an option selects it; Escape closes and returns focus', () => {
    const set = setup();
    const btn = screen.getByRole('button', { name: 'Switch asset' });
    fireEvent.click(btn);
    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(set).toHaveBeenCalledWith('dis:1:1:1003');

    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('closes on an outside click', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the empty-scope message for an empty fleet', () => {
    setup('', []);
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    expect(screen.getByText('— no assets in scope —')).toBeTruthy();
  });
});

describe('AssetSwitcher arrivals', () => {
  type C = { undeclared: number; expected: number; overdue: number } | null;
  function withArrivals(counts: C, unavailable = false, view: ReactNode = <input data-testid="av-input" />) {
    const set = vi.fn();
    render(
      <AssetSwitcher
        fleet={FLEET} fleetTiers={TIERS} selectedAsset="dis:1:1:1001" setSelectedAsset={set}
        arrivals={{ counts, unavailable, view }}
      />,
    );
    return set;
  }

  it('no badge without arrivals or with 0/0', () => {
    setup();
    expect(screen.queryByTestId('arrivals-badge')).toBeNull();
    cleanup();
    withArrivals({ undeclared: 0, expected: 0, overdue: 0 });
    expect(screen.queryByTestId('arrivals-badge')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('badge text forms and amber styling', () => {
    withArrivals({ undeclared: 1, expected: 2, overdue: 0 });
    const b = screen.getByTestId('arrivals-badge');
    expect(b.textContent).toBe('1 undeclared · 2 expected');
    expect(b.getAttribute('aria-label')).toBe('Arrivals: 1 undeclared · 2 expected');
    expect(b.className).toContain('text-amber-300');
    cleanup();
    withArrivals({ undeclared: 0, expected: 2, overdue: 0 });
    expect(screen.getByTestId('arrivals-badge').textContent).toBe('2 expected');
    expect(screen.getByTestId('arrivals-badge').className).not.toContain('text-amber-300');
    cleanup();
    withArrivals({ undeclared: 1, expected: 2, overdue: 1 });
    expect(screen.getByTestId('arrivals-badge').textContent).toBe('1 undeclared · 2 expected · 1 overdue');
  });

  it('badge opens on the Arrivals tab with the view; "/" opens on Fleet', () => {
    withArrivals({ undeclared: 1, expected: 2, overdue: 0 });
    fireEvent.click(screen.getByTestId('arrivals-badge'));
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toBe('Fleet');
    expect(tabs[1].textContent).toBe('Arrivals 3');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('av-input')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('av-input'), { key: 'Escape' });
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('ArrowDown in an input inside the arrivals view does not move the fleet selection', () => {
    const set = withArrivals({ undeclared: 1, expected: 0, overdue: 0 });
    fireEvent.click(screen.getByTestId('arrivals-badge'));
    const ev = fireEvent.keyDown(screen.getByTestId('av-input'), { key: 'ArrowDown' });
    expect(ev).toBe(true);
    fireEvent.keyDown(screen.getByTestId('av-input'), { key: 'Enter' });
    expect(set).not.toHaveBeenCalled();
  });

  it('shows an unavailable line on error', () => {
    withArrivals(null, true);
    expect(screen.getByTestId('arrivals-unavailable').textContent).toBe('arrivals unavailable');
    expect(screen.queryByTestId('arrivals-badge')).toBeNull();
  });
});
