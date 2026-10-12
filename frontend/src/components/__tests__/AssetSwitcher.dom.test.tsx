// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssetSwitcher from '../AssetSwitcher';
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

  it('opens from the button and from "/" but not while typing in an input', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Switch asset' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    const other = document.createElement('input');
    document.body.appendChild(other);
    fireEvent.keyDown(other, { key: '/' });
    expect(screen.queryByRole('listbox')).toBeNull();
    other.remove();
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
