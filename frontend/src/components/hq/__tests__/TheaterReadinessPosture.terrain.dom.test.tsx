// @vitest-environment jsdom
// HQ map: the terrain controls, their persistence, and the credit line.
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockFobs: unknown[] = [];
vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: [], isLoading: false }),
  useMunitionTrackFeed: () => ({ data: [], isLoading: false }),
  useAllEffectorLaunches: () => ({ data: [], isLoading: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));
vi.mock('../../../deployment', () => ({
  deployment: () => ({ fobs: mockFobs, tiers: undefined }),
  edgeAttachment: () => undefined,
}));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useFrame: () => {},
  useThree: () => ({ size: { width: 800, height: 600 }, gl: { getPixelRatio: () => 1 } }),
}));
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  OrbitControls: () => null,
  Grid: () => null,
  Line: () => null,
}));
vi.mock('@react-three/postprocessing', () => ({ EffectComposer: () => null, Bloom: () => null }));
vi.mock('../../TacticalMapUnderlay', () => ({ default: () => null }));
// Terrain stays off the network: no tile or land-file fetches from an HQ test.
vi.mock('../../terrain/theater', () => ({
  useTheaterTerrain: () => ({ theater: null, surround: null, mask: { theater: null, surround: null }, rect: null, groundY: () => 0 }),
  TheaterTerrain: () => null,
}));

import TheaterReadinessPosture from '../TheaterReadinessPosture';
import { HQ_TERRAIN_PREFS_KEY } from '../../terrain/prefs';
import { DEFAULT_TERRAIN_SOURCE, elevationCredit } from '../../../lib/terrainTiles';

const stored = () => JSON.parse(localStorage.getItem(HQ_TERRAIN_PREFS_KEY)!);

describe('TheaterReadinessPosture terrain controls', () => {
  beforeEach(() => {
    localStorage.clear();
    mockFobs.length = 0;
    mockFobs.push({ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' });
  });
  afterEach(() => cleanup());

  it('renders the controls with terrain on and satellite selected', () => {
    render(<TheaterReadinessPosture />);
    expect(screen.getByTestId('hq-terrain-controls')).toBeTruthy();
    expect(screen.getByTestId('hq-terrain-toggle').textContent).toContain('ON');
    expect(screen.getByTestId('hq-terrain-style-sat').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('hq-terrain-style-holo').getAttribute('aria-pressed')).toBe('false');
    for (const x of [1, 5, 20]) expect(screen.getByTestId(`hq-terrain-exag-${x}`)).toBeTruthy();
  });

  it('remembers the toggle, the style and the relief', () => {
    render(<TheaterReadinessPosture />);
    fireEvent.click(screen.getByTestId('hq-terrain-style-holo'));
    fireEvent.click(screen.getByTestId('hq-terrain-exag-5'));
    expect(stored()).toEqual({ on: true, style: 'holo', exag: 5 });
    fireEvent.click(screen.getByTestId('hq-terrain-toggle'));
    expect(stored().on).toBe(false);
    expect(screen.getByTestId('hq-terrain-toggle').textContent).toContain('OFF');
    expect(screen.queryByTestId('hq-terrain-style-holo')).toBeNull();
    expect(screen.queryByTestId('hq-terrain-exag-5')).toBeNull();
    expect(screen.queryByTestId('hq-terrain-attribution')).toBeNull();
  });

  it('starts from the stored prefs', () => {
    localStorage.setItem(HQ_TERRAIN_PREFS_KEY, JSON.stringify({ on: true, style: 'holo', exag: 20 }));
    render(<TheaterReadinessPosture />);
    expect(screen.getByTestId('hq-terrain-style-holo').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('hq-terrain-exag-20').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the full credit on satellite and the elevation credit on holo, plus the coastline', () => {
    render(<TheaterReadinessPosture />);
    const sat = screen.getByTestId('hq-terrain-attribution').textContent!;
    expect(sat).toBe(`${DEFAULT_TERRAIN_SOURCE.attribution} · Coastline: Natural Earth`);
    fireEvent.click(screen.getByTestId('hq-terrain-style-holo'));
    const holo = screen.getByTestId('hq-terrain-attribution').textContent!;
    expect(holo).toBe(`${elevationCredit(DEFAULT_TERRAIN_SOURCE.attribution)} · Coastline: Natural Earth`);
    expect(holo).not.toContain('Esri');
  });

  it('shows no controls and no credit without FOBs', () => {
    mockFobs.length = 0;
    render(<TheaterReadinessPosture />);
    expect(screen.queryByTestId('hq-terrain-controls')).toBeNull();
    expect(screen.queryByTestId('hq-terrain-attribution')).toBeNull();
  });
});
