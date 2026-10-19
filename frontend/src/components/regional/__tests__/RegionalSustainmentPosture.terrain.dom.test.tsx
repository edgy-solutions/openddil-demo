// @vitest-environment jsdom
// Regional map: the terrain controls (toggle, style, gear, relief) and their persistence.
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../hooks', () => ({
  useFleetAssetsForRegion: () => ({ data: [], isLoading: false, isError: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useAllCapabilityState: () => ({ data: [], isLoading: false }),
  useFleetTiers: () => new Map(),
  useMunitionsStockpile: () => ({ data: [], entries: [] }),
  useAllEffectorLaunches: () => ({ data: [], isLoading: false }),
  useAllEffectorResupply: () => ({ data: [], isLoading: false }),
  useInFlightMunitionTracks: () => ({ data: [], isLoading: false }),
  useMunitionTrackFeed: () => ({ data: [], isLoading: false }),
  useEdgeBuffer: () => ({ status: null, isError: false }),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));
vi.mock('../../../hooks/useEffectorLaunches', () => ({ useMunitionLaunches: () => ({ data: [] }) }));
vi.mock('../../../hooks/useLinkIndicator', () => ({ useLinkIndicator: () => 'up' }));
vi.mock('../../terrain/terrainData', async (orig) => ({ ...(await orig<typeof import('../../terrain/terrainData')>()), useTerrain: () => ({ data: null, failed: false }), usePatches: () => [] }));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useFrame: () => {},
  useThree: () => ({ size: { width: 800, height: 600 }, gl: { getPixelRatio: () => 1 } }),
}));
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Line: () => null,
  OrbitControls: () => null,
}));

import RegionalSustainmentPosture from '../RegionalSustainmentPosture';
import { TERRAIN_PREFS_KEY } from '../../terrain/prefs';

const view = () => render(
  <RegionalSustainmentPosture
    regionId="r1"
    linkControl={{ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }}
    aorAssetCount={0}
    selectedAssetId={null}
    onAssetSelect={() => {}}
  />,
);

describe('RegionalSustainmentPosture terrain controls', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('renders the controls with terrain on, style buttons and relief', () => {
    view();
    expect(screen.getByTestId('terrain-controls')).toBeTruthy();
    expect(screen.getByTestId('terrain-toggle').textContent).toContain('ON');
    expect(screen.getByTestId('terrain-style-holo')).toBeTruthy();
    expect(screen.getByTestId('terrain-style-sat')).toBeTruthy();
    expect(screen.getByTestId('terrain-relief-5')).toBeTruthy();
    expect(screen.getByTestId('terrain-attribution')).toBeTruthy();
  });

  it('labels the second style button RELIEF by default and shows no credit line the config does not state', () => {
    view();
    expect(screen.getByTestId('terrain-style-sat').textContent).toBe('RELIEF');
    const lines = Array.from(screen.getByTestId('terrain-attribution').children).map((c) => c.textContent);
    expect(lines).toEqual([]);
    expect(screen.getByTestId('terrain-attribution').textContent).not.toMatch(/imagery/i);
  });

  it('opens on relief, not holo, with nothing stored', () => {
    view();
    expect(screen.getByTestId('terrain-style-sat').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('terrain-style-holo').getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(TERRAIN_PREFS_KEY)).toBeNull();
  });

  it('hides HOLO and SATELLITE when terrain is off, and remembers it', () => {
    view();
    fireEvent.click(screen.getByTestId('terrain-toggle'));
    expect(screen.getByTestId('terrain-toggle').textContent).toContain('OFF');
    expect(screen.queryByTestId('terrain-style-holo')).toBeNull();
    expect(screen.queryByTestId('terrain-style-sat')).toBeNull();
    expect(screen.queryByTestId('terrain-attribution')).toBeNull();
    expect(JSON.parse(localStorage.getItem(TERRAIN_PREFS_KEY)!).on).toBe(false);
  });

  it('opens the holo panel from the gear', () => {
    view();
    fireEvent.click(screen.getByTestId('terrain-style-holo'));
    expect(screen.queryByTestId('holo-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('terrain-holo-gear'));
    expect(screen.getByTestId('holo-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terrain-holo-gear'));
    expect(screen.queryByTestId('holo-panel')).toBeNull();
  });

  it('has no gear on the satellite style', () => {
    view();
    fireEvent.click(screen.getByTestId('terrain-style-sat'));
    expect(screen.queryByTestId('terrain-holo-gear')).toBeNull();
  });
});
