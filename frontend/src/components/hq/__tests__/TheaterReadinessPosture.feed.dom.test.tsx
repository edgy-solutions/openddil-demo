// @vitest-environment jsdom
// HQ map: the holo gets the Fire PDU's target at that asset's fleet position,
// and the launch ring anchors at the launcher's own position, not its FOB.
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
const state = { fleet: [] as unknown[], launches: [] as unknown[], ground: 0 };

vi.mock('../../MunitionTrackHolo', () => ({
  default: (p: Record<string, unknown>) => { holoProps.push(p); return null; },
}));
vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: state.fleet, isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: [flying], isLoading: false }),
  useMunitionTrackFeed: () => ({ data: [flying], isLoading: false }),
  useAllEffectorLaunches: () => ({ data: state.launches, isLoading: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));
vi.mock('../../../deployment', () => ({
  deployment: () => ({ fobs: [{ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' }], tiers: undefined }),
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
  useTheaterTerrain: () => ({ theater: null, surround: null, mask: { theater: null, surround: null }, rect: null, groundY: () => state.ground }),
  TheaterTerrain: () => null,
}));

import TheaterReadinessPosture from '../TheaterReadinessPosture';

const asset = (id: string, position: { lat: number; lon: number; alt?: number } | null) =>
  ({ asset_id: id, edge_id: 'edge-01', asset_class: 'LAUNCHER', platform_variant: 'X', position });
const last = () => holoProps[holoProps.length - 1];

describe('TheaterReadinessPosture holo target and launcher', () => {
  afterEach(() => { cleanup(); holoProps.length = 0; state.fleet = []; state.launches = []; state.ground = 0; });

  it('passes a target when the launch row names an asset with a fleet position', () => {
    state.fleet = [asset('dis:9:9:2', null), asset('dis:9:9:3', { lat: 10.2, lon: 20.2 })];
    state.launches = [{ eventUrn: 'dis-event:9:9:7', targetAssetId: 'dis:9:9:3' }];
    render(<TheaterReadinessPosture />);
    const t = last().target as number[];
    expect(t).toHaveLength(3);
    expect(t[1]).toBe(0);
    expect(Math.abs(t[0]) + Math.abs(t[2])).toBeGreaterThan(0);
  });

  it('has no target when the named asset has no position', () => {
    state.fleet = [asset('dis:9:9:2', null), asset('dis:9:9:3', null)];
    state.launches = [{ eventUrn: 'dis-event:9:9:7', targetAssetId: 'dis:9:9:3' }];
    render(<TheaterReadinessPosture />);
    expect(last().target).toBeUndefined();
  });

  it('anchors the launch ring at the launcher own position, not the FOB', () => {
    state.fleet = [asset('dis:9:9:2', null)];
    render(<TheaterReadinessPosture />);
    const fobAnchor = last().launcher as number[];
    cleanup();
    holoProps.length = 0;
    state.fleet = [asset('dis:9:9:2', { lat: 10.3, lon: 20.3 })];
    render(<TheaterReadinessPosture />);
    const own = last().launcher as number[];
    expect(own[1]).toBe(0);
    expect(own[0] !== fobAnchor[0] || own[2] !== fobAnchor[2]).toBe(true);
  });

  it('frames the flight in the engagement inset while a track is in flight', () => {
    render(<TheaterReadinessPosture />);
    expect(screen.getByTestId('engagement-inset').textContent).toContain('1 IN FLIGHT');
  });

  it('measures track height above the launcher altitude, not the ellipsoid', () => {
    const h = trackLatLon(flying)!.h;
    state.fleet = [asset('dis:9:9:2', { lat: 10, lon: 20, alt: h - 2000 })];
    render(<TheaterReadinessPosture />);
    const trail = last().trail as number[][];
    expect(trail[trail.length - 1][1]).toBeCloseTo(2 * (400 / 111), 6);
  });

  it('with terrain off the inset and holo ground is 0', () => {
    state.fleet = [asset('dis:9:9:2', { lat: 10, lon: 20 })];
    render(<TheaterReadinessPosture />);
    expect(last().groundY).toBe(0);
    expect((last().launcher as number[])[1]).toBe(0);
  });

  it('puts the launcher, the holo ground and every trail point on the terrain', () => {
    state.ground = 7;
    state.fleet = [asset('dis:9:9:2', { lat: 10, lon: 20 })];
    render(<TheaterReadinessPosture />);
    expect(last().groundY).toBe(7);
    expect((last().launcher as number[])[1]).toBe(7);
    const trail = last().trail as number[][];
    expect(trail.length).toBeGreaterThan(0);
    for (const p of trail) expect(p[1]).toBeGreaterThanOrEqual(7);
  });
});
