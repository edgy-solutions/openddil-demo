// @vitest-environment jsdom
// One munition in flight on the HQ map mounts the holo track's test anchor.
// The Canvas is a passthrough div and drei's Html a plain div, so the R3F
// elements (<points>, <mesh>) become inert unknown DOM nodes; the anchor is
// the only thing asserted. jsdom has no WebGL.
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

vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: mockTracks, isLoading: false }),
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

import TheaterReadinessPosture from '../TheaterReadinessPosture';

describe('TheaterReadinessPosture munition track', () => {
  afterEach(cleanup);

  it('mounts the holo anchor for one in-flight munition', async () => {
    render(<TheaterReadinessPosture />);
    const el = await screen.findByTestId('munition-track-marker');
    expect(el.getAttribute('data-munition')).toBe('dis:9:9:1');
  });
});
