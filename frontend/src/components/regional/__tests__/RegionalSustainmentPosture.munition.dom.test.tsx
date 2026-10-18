// @vitest-environment jsdom
// One munition in flight on the regional map mounts the holo track's test
// anchor. Canvas is a passthrough div and Html a plain div (jsdom has no WebGL).
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { mapMunitionTrack } from '../../../hooks/useMunitionTracks';

const r = 6371000 + 5000;
const la = (10 * Math.PI) / 180;
const lo = (20 * Math.PI) / 180;
const flying = mapMunitionTrack({
  munition_asset_id: 'dis:9:9:1',
  launcher_asset_id: null,
  munition_type: '2.1.225.1.0.0.0',
  ecef_x: r * Math.cos(la) * Math.cos(lo),
  ecef_y: r * Math.cos(la) * Math.sin(lo),
  ecef_z: r * Math.sin(la),
});
const mockTracks = [flying];

vi.mock('../../../hooks', () => ({
  useFleetAssetsForRegion: () => ({ data: [], isLoading: false, isError: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useAllCapabilityState: () => ({ data: [], isLoading: false }),
  useFleetTiers: () => new Map(),
  useMunitionsStockpile: () => ({ data: [], entries: [] }),
  useAllEffectorLaunches: () => ({ data: [], isLoading: false }),
  useAllEffectorResupply: () => ({ data: [], isLoading: false }),
  useInFlightMunitionTracks: () => ({ data: mockTracks, isLoading: false }),
  useMunitionTrackFeed: () => ({ data: mockTracks, isLoading: false }),
  useEdgeBuffer: () => ({ status: null, isError: false }),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));
vi.mock('../../../hooks/useEffectorLaunches', () => ({ useMunitionLaunches: () => ({ data: [] }) }));
vi.mock('../../../hooks/useLinkIndicator', () => ({ useLinkIndicator: () => 'up' }));
vi.mock('../../terrain/terrain', async (orig) => ({ ...(await orig<typeof import('../../terrain/terrain')>()), useTerrain: () => null, usePatches: () => [] }));
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

describe('RegionalSustainmentPosture munition track', () => {
  afterEach(cleanup);

  it('mounts the holo anchor for one in-flight munition', async () => {
    render(
      <RegionalSustainmentPosture
        regionId="r1"
        linkControl={{ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }}
        aorAssetCount={0}
        selectedAssetId={null}
        onAssetSelect={() => {}}
      />,
    );
    const el = await screen.findByTestId('munition-track-marker');
    expect(el.getAttribute('data-munition')).toBe('dis:9:9:1');
  });
});
