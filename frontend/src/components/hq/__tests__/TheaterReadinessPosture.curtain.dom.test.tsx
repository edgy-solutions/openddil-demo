// @vitest-environment jsdom
// One munition in flight on the HQ map mounts the holo track's test anchor.
// The Canvas is a passthrough div and drei's Html a plain div, so the R3F
// elements (<points>, <mesh>) become inert unknown DOM nodes; the anchor is
// the only thing asserted. jsdom has no WebGL.
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
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
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...flying, munitionAssetId: `dis:9:9:${i + 1}` }));
let mockTracks = [flying];
const holoProps: Array<{ curtain?: boolean }> = [];

vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: mockTracks, isLoading: false }),
  useMunitionTrackFeed: () => ({ data: mockTracks, isLoading: false }),
  useAllEffectorLaunches: () => ({ data: [], isLoading: false }),
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

vi.mock("../../MunitionTrackHolo", () => ({
  CURTAIN_MAX_TRACKS: 12,
  default: (p: { curtain?: boolean }) => { holoProps.push(p); return null; },
}));

import TheaterReadinessPosture from '../TheaterReadinessPosture';

describe("TheaterReadinessPosture curtain gating", () => {
  afterEach(() => { cleanup(); holoProps.length = 0; });

  it.each([[12, true], [13, false]])("%i in-flight tracks -> curtain=%s", async (n, want) => {
    mockTracks = many(n);
    render(<TheaterReadinessPosture />);
    await waitFor(() => expect(holoProps.length).toBeGreaterThanOrEqual(n));
    const last = holoProps.slice(-n);
    expect(last.every((p) => p.curtain === want)).toBe(true);
  });
});
