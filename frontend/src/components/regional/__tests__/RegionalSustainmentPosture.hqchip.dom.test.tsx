// @vitest-environment jsdom
// Regional map: with the regional node and HQ on the map at real sites, an HQ beyond the frame
// is a chip at the border that reads its distance and, in the shell, opens the HQ view.
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../../terrain/terrain', async (orig) => ({ ...(await orig<typeof import('../../terrain/terrain')>()), useTerrain: () => ({ data: null, failed: false }), usePatches: () => [] }));
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
// Made-up places: one FOB and the regional node near lat 10, lon 20; HQ about 300 km north.
vi.mock('../../../deployment', async (orig) => {
  const real = await orig<typeof import('../../../deployment')>();
  const dep = () => ({
    ...real.deployment(),
    fobs: [{ edge_id: 'fob-a', region_id: 'r1', lat: 10, lon: 20, label: 'FOB A' }],
    tiers: [{ id: 'r1', parent: null, hasChildren: true, lat: 10.02, lon: 20.02, label: 'Node One' }],
    hq: { lat: 12.7, lon: 20.02 },
  });
  return { ...real, deployment: dep };
});

import RegionalSustainmentPosture from '../RegionalSustainmentPosture';

const view = (onOpenHq?: () => void) => render(
  <RegionalSustainmentPosture
    regionId="r1"
    linkControl={{ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }}
    aorAssetCount={0}
    selectedAssetId={null}
    onAssetSelect={() => {}}
    onOpenHq={onOpenHq}
  />,
);

describe('off-map HQ chip', () => {
  afterEach(() => cleanup());

  it('reads the distance and bearing, and opens HQ on click', () => {
    const open = vi.fn();
    view(open);
    const chip = screen.getByTestId('hq-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toMatch(/^HQ · \d+ km →$/);
    expect(chip.getAttribute('aria-label')).toMatch(/^HQ, \d+ km, bearing \d+°$/);
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is plain text when nothing can open HQ', () => {
    view();
    expect(screen.getByTestId('hq-chip').tagName).toBe('SPAN');
  });
});
