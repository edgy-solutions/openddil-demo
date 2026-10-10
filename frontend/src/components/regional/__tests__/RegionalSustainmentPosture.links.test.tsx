// The overlay (title + THEATER LINK STATUS card) sits outside the R3F Canvas,
// so renderToStaticMarkup reaches it; the Canvas itself is stubbed to nothing.
// '../../../hooks' touches `window` at module scope through electric.ts, so it
// is mocked here for that reason alone, independent of anything under test.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UseLinkControlResult } from '../../../hooks/useLinkControl';
import type { LinkStatusRow } from '../../../lib/linkStatus';

const mockEdgeBuffer = vi.fn();
const mockLinkStatus = vi.fn();
const mockIndicator = vi.fn();
vi.mock('../../../hooks', () => ({
  useFleetAssetsForRegion: () => ({ data: [], isLoading: false, isError: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useAllCapabilityState: () => ({ data: [], isLoading: false }),
  useFleetTiers: () => new Map(),
  useMunitionsStockpile: () => ({ data: [] }),
  stockpileForLauncher: () => null,
  useEdgeBuffer: () => mockEdgeBuffer(),
  useLinkStatus: () => mockLinkStatus(),
}));
vi.mock('../../../hooks/useEffectorLaunches', () => ({
  useMunitionLaunches: () => ({ data: [] }),
}));
vi.mock('../../../hooks/useLinkIndicator', () => ({
  useLinkIndicator: () => mockIndicator(),
}));
vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useFrame: () => {},
  useThree: () => ({}),
}));
vi.mock('@react-three/drei', () => ({
  Html: () => null,
  Line: () => null,
  OrbitControls: () => null,
}));

import RegionalSustainmentPosture from '../RegionalSustainmentPosture';

function row(id: string, state: string): LinkStatusRow {
  return {
    id, link_state: state, traffic: 'none', declared_idle: false,
    heartbeat_age_s: 1, last_heartbeat_at: null, bridge_lag: 0,
    updated_at: new Date().toISOString(),
  };
}

const control: UseLinkControlResult = {
  status: 'ready',
  uplink: null,
  children: [
    { id: 'edge-01', enabled: true, toxics: null },
    { id: 'edge-02', enabled: true, toxics: null },
  ],
  set: () => {},
  setToxics: () => {},
};

function render(indicator: string, aorAssetCount = 20): string {
  mockEdgeBuffer.mockReturnValue({ status: null, isError: false });
  mockIndicator.mockReturnValue(indicator);
  mockLinkStatus.mockReturnValue({
    links: new Map([row('edge-01', 'up'), row('edge-02', 'up')].map((r) => [r.id, r])),
    isLoading: false, isError: false,
  });
  return renderToStaticMarkup(
    <RegionalSustainmentPosture
      regionId="r1"
      linkControl={control}
      aorAssetCount={aorAssetCount}
      selectedAssetId={null}
      onAssetSelect={() => {}}
    />,
  );
}

describe('RegionalSustainmentPosture — link card and title count', () => {
  it('counts the uplink and both children when all are up', () => {
    expect(render('up')).toContain('3 UP · 0 IDLE · 0 DOWN');
  });

  it('counts a severed uplink as down', () => {
    expect(render('severed')).toContain('2 UP · 0 IDLE · 1 DOWN');
  });

  it('never counts an unobserved uplink as up', () => {
    const html = render('unknown');
    expect(html).toContain('2 UP · 0 IDLE · 0 DOWN · 1 UNKNOWN');
  });

  it('title counts the AOR rows even when no asset is renderable on the map', () => {
    const html = render('up', 20);
    expect(html).toContain('20 ASSETS');
    expect(html).toContain('0 ON MAP');
  });
});
