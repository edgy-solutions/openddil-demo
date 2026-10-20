// @vitest-environment jsdom
// Regional map: each FOB -> regional line reads that FOB's link_status row, and the
// regional -> HQ line reads the uplink indicator. Unobserved is UNKNOWN, never green.
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const mockIndicator = vi.fn();
const now = new Date().toISOString();
const row = (id: string, link_state: string) => ({
  id, link_state, traffic: '', declared_idle: false, heartbeat_age_s: 1,
  last_heartbeat_at: now, bridge_lag: 0, updated_at: now,
});
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
  useLinkStatus: () => ({
    links: new Map([['fob-a', row('fob-a', 'up')], ['fob-b', row('fob-b', 'idle')]]),
    isLoading: false, isError: false,
  }),
}));
vi.mock('../../../hooks/useEffectorLaunches', () => ({ useMunitionLaunches: () => ({ data: [] }) }));
vi.mock('../../../hooks/useLinkIndicator', () => ({ useLinkIndicator: () => mockIndicator() }));
vi.mock('../../terrain/terrain', async (orig) => ({ ...(await orig<typeof import('../../terrain/terrain')>()), useTerrain: () => ({ data: null, failed: false }), usePatches: () => [] }));
vi.mock('../../DdilNetworkLink', () => ({
  default: ({ status }: { status: string }) => <div data-testid="ddil-line" data-status={status} />,
}));
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
// Made-up places: two FOBs and the regional node near lat 10, lon 20; HQ about 300 km north.
vi.mock('../../../deployment', async (orig) => {
  const real = await orig<typeof import('../../../deployment')>();
  const dep = () => ({
    ...real.deployment(),
    fobs: [
      { edge_id: 'fob-a', region_id: 'r1', lat: 10, lon: 20, label: 'FOB A' },
      { edge_id: 'fob-b', region_id: 'r1', lat: 10.05, lon: 20.05, label: 'FOB B' },
    ],
    tiers: [{ id: 'r1', parent: null, hasChildren: true }],
    tierSites: [{ tier_id: 'r1', lat: 10.02, lon: 20.02, label: 'Node One' }],
    hq: { lat: 12.7, lon: 20.02 },
  });
  return { ...real, deployment: dep };
});

import RegionalSustainmentPosture from '../RegionalSustainmentPosture';

const view = () => render(
  <RegionalSustainmentPosture
    regionId="r1"
    linkControl={{ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }}
    aorAssetCount={0}
    selectedAssetId={null}
    onAssetSelect={() => {}}
  />,
);

describe('regional line status', () => {
  afterEach(() => cleanup());

  it('FOB lines follow their link rows; an unobserved uplink is UNKNOWN', () => {
    mockIndicator.mockReturnValue('unknown');
    const { getAllByTestId } = view();
    const statuses = getAllByTestId('ddil-line').map((n) => n.getAttribute('data-status'));
    expect(statuses.slice().sort()).toEqual(['IDLE', 'NOMINAL', 'UNKNOWN']);
  });

  it('an observed-up uplink is NOMINAL', () => {
    mockIndicator.mockReturnValue('up');
    const { getAllByTestId } = view();
    const statuses = getAllByTestId('ddil-line').map((n) => n.getAttribute('data-status'));
    expect(statuses.slice().sort()).toEqual(['IDLE', 'NOMINAL', 'NOMINAL']);
  });
});
