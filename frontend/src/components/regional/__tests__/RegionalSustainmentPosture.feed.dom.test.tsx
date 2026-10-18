// @vitest-environment jsdom
// Regional map: the holo gets the Fire PDU's target at that asset's drawn position.
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { mapMunitionTrack } from '../../../hooks/useMunitionTracks';
import { trackLatLon } from '../../../lib/munitionTrackLayout';

const r = 6371000 + 5000;
const la = (10 * Math.PI) / 180;
const lo = (20 * Math.PI) / 180;
const flying = mapMunitionTrack({
  munition_asset_id: 'dis:9:9:1',
  launcher_asset_id: 'dis:9:9:2',
  event_urn: 'dis-event:9:9:7',
  munition_type: '2.1.225.1.0.0.0',
  ecef_x: r * Math.cos(la) * Math.cos(lo),
  ecef_y: r * Math.cos(la) * Math.sin(lo),
  ecef_z: r * Math.sin(la),
});
const holoProps: Array<Record<string, unknown>> = [];
const state = { fleet: [] as unknown[], launches: [] as unknown[] };

vi.mock('../../MunitionTrackHolo', () => ({
  CURTAIN_MAX_TRACKS: 12,
  default: (p: Record<string, unknown>) => { holoProps.push(p); return null; },
}));
vi.mock('../../../hooks', () => ({
  useFleetAssetsForRegion: () => ({ data: state.fleet, isLoading: false, isError: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useAllCapabilityState: () => ({ data: [], isLoading: false }),
  useFleetTiers: () => new Map(),
  useMunitionsStockpile: () => ({ data: [], entries: [] }),
  useAllEffectorLaunches: () => ({ data: state.launches, isLoading: false }),
  useAllEffectorResupply: () => ({ data: [], isLoading: false }),
  useInFlightMunitionTracks: () => ({ data: [flying], isLoading: false }),
  useMunitionTrackFeed: () => ({ data: [flying], isLoading: false }),
  useEdgeBuffer: () => ({ status: null, isError: false }),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));
vi.mock('../../../hooks/useEffectorLaunches', () => ({ useMunitionLaunches: () => ({ data: [] }) }));
vi.mock('../../../hooks/useLinkIndicator', () => ({ useLinkIndicator: () => 'up' }));
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
vi.mock('../../TacticalMapUnderlay', () => ({ default: () => null }));

import RegionalSustainmentPosture from '../RegionalSustainmentPosture';

const last = () => holoProps[holoProps.length - 1];

const view = () => render(
  <RegionalSustainmentPosture
    regionId="r1"
    linkControl={{ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }}
    aorAssetCount={0}
    selectedAssetId={null}
    onAssetSelect={() => {}}
  />,
);
const asset = (id: string, position: { lat: number; lon: number; alt?: number } | null) => ({
  asset_id: id, platform_variant: 'GENERIC', region_id: 'r1', edge_id: 'edge-01', position,
});

describe('RegionalSustainmentPosture holo target', () => {
  afterEach(() => { cleanup(); holoProps.length = 0; state.fleet = []; state.launches = []; });

  it('passes a ground target when the launch row names a drawn asset', () => {
    state.fleet = [asset('dis:9:9:3', { lat: 10.1, lon: 20.1 })];
    state.launches = [{ eventUrn: 'dis-event:9:9:7', targetAssetId: 'dis:9:9:3' }];
    view();
    const t = holoProps[holoProps.length - 1].target as number[];
    expect(t).toHaveLength(3);
    expect(t[1]).toBe(0);
  });

  it('has no target when the launch row names nothing drawn', () => {
    state.fleet = [asset('dis:9:9:3', { lat: 10.1, lon: 20.1 })];
    state.launches = [{ eventUrn: 'dis-event:9:9:7', targetAssetId: 'dis:9:9:99' }];
    view();
    expect(holoProps[holoProps.length - 1].target).toBeUndefined();
  });

  it('frames the flight in the engagement inset while a track is in flight', () => {
    view();
    expect(screen.getByTestId('engagement-inset').textContent).toContain('1 IN FLIGHT');
  });

  it('measures track height above the launcher altitude, not the ellipsoid', () => {
    const h = trackLatLon(flying)!.h;
    state.fleet = [asset('dis:9:9:2', { lat: 10, lon: 20, alt: h - 2000 })];
    view();
    const trail = last().trail as number[][];
    expect(trail[trail.length - 1][1]).toBeCloseTo(2 * (80 / 111), 6);
  });
});
