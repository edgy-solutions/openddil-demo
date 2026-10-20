// @vitest-environment jsdom
// HQ map: HQ, a region and a FOB at one spot draw one label stack.
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mockFobs: unknown[] = [];
let mockDep: Record<string, unknown> = {};
const mockLinks = new Map<string, unknown>();
vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: [], isLoading: false }),
  useMunitionTrackFeed: () => ({ data: [], isLoading: false }),
  useAllEffectorLaunches: () => ({ data: [], isLoading: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useLinkStatus: () => ({ links: mockLinks, isLoading: false, isError: false }),
}));
vi.mock('../../../deployment', () => ({
  deployment: () => ({ fobs: mockFobs, ...mockDep }),
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
vi.mock('../../terrain/theater', () => ({ TheaterTerrain: () => null }));
vi.mock('../../terrain/theaterData', () => ({
  useTheaterTerrain: () => ({ theater: null, surround: null, mask: { theater: {}, surround: null }, rect: null, failed: false, groundY: () => 0 }),
}));

import TheaterReadinessPosture from '../TheaterReadinessPosture';

describe('TheaterReadinessPosture shared sites', () => {
  afterEach(() => cleanup());

  it('draws HQ, a region and a FOB at one spot as one stack, each label once', () => {
    mockFobs.length = 0;
    mockFobs.push({ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' });
    mockDep = {
      hq: { lat: 10, lon: 20 },
      tiers: [
        { id: 'region-a', parent: null, hasChildren: true },
        { id: 'edge-01', parent: 'region-a', hasChildren: false },
      ],
      tierSites: [{ tier_id: 'region-a', lat: 10, lon: 20 }],
    };
    render(<TheaterReadinessPosture />);
    expect(screen.getAllByTestId('hq-node-label')).toHaveLength(1);
    expect(screen.getAllByText('region-a')).toHaveLength(1);
    expect(screen.getAllByText('edge-01')).toHaveLength(1);
  });

  it('keeps separate labels for sites that are apart', () => {
    mockFobs.length = 0;
    mockFobs.push({ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' });
    mockDep = { hq: { lat: 11, lon: 21 } };
    render(<TheaterReadinessPosture />);
    expect(screen.getAllByTestId('hq-node-label')).toHaveLength(1);
    expect(screen.getAllByText('edge-01')).toHaveLength(1);
  });

  it('names the parent on a co-sited FOB whose link is not drawn', () => {
    const fresh = new Date().toISOString();
    mockLinks.clear();
    mockLinks.set('edge-01', {
      id: 'edge-01', link_state: 'idle', traffic: '', declared_idle: false, heartbeat_age_s: 1,
      last_heartbeat_at: fresh, bridge_lag: 0, updated_at: fresh,
    });
    mockFobs.length = 0;
    mockFobs.push({ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' });
    mockDep = {
      hq: { lat: 10, lon: 20 },
      tiers: [{ id: 'edge-01', parent: null, hasChildren: false }],
    };
    const { container } = render(<TheaterReadinessPosture />);
    expect(container.querySelector('[data-link-state="IDLE"]')).not.toBeNull();
    expect(container.querySelector('[data-link-to="HQ"]')).not.toBeNull();
    cleanup();
    mockLinks.clear();
  });

  it('shows no parent suffix on a FOB elsewhere', () => {
    mockFobs.length = 0;
    mockFobs.push({ edge_id: 'edge-01', region_id: 'r1', lat: 10, lon: 20, name: 'f' });
    mockDep = {
      hq: { lat: 11, lon: 21 },
      tiers: [{ id: 'edge-01', parent: null, hasChildren: false }],
    };
    const { container } = render(<TheaterReadinessPosture />);
    expect(container.querySelector('[data-link-to]')).toBeNull();
  });
});
