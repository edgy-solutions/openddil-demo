// FobLabel is the only per-FOB UI TheaterReadinessPosture renders, but it
// is mounted through drei's <Html> inside an R3F <Canvas>, whose scene
// graph mounts via a layout effect gated on a real DOM measurement — it
// never fires under renderToStaticMarkup (no jsdom in this project's
// vitest config). FobLabel is exported specifically so this per-FOB
// decision (the HQ-ATTACHED tag) can be render-tested directly, same
// reasoning as deployment.ts's parseTier/parseEgressPane.
//
// Importing the module at all pulls in '../../hooks', which (through
// useFleetAssets/electric.ts) touches window at module scope -- not
// available under this project's Node (non-jsdom) vitest environment.
// Mocked here for the same reason, independent of anything under test.
//
// drei's real <Html> calls useThree(), which throws ("R3F: Hooks can
// only be used within the Canvas component!") outside a mounted R3F
// Canvas -- renderToStaticMarkup never provides one. Stood up here as a
// plain passthrough so FobLabel's own markup (the thing under test) is
// reachable at all; OrbitControls/Grid are stubbed too since they share
// the module but are never rendered by FobLabel itself.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mockFobs: any[] = [];
const mockTiers: any[] = [];
const mockLinkStatus = vi.fn(() => ({ links: new Map(), isLoading: false, isError: false }));
const mockLinkControl = vi.fn();
vi.mock('../../../hooks/useLinkControl', () => ({
  useLinkControl: () => mockLinkControl(),
}));
vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useInFlightMunitionTracks: () => ({ data: [], isLoading: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
  useLinkStatus: () => mockLinkStatus(),
}));
vi.mock('../../../deployment', () => ({
  deployment: () => ({ fobs: mockFobs, tiers: mockTiers.length ? mockTiers : undefined }),
  edgeAttachment: () => undefined,
}));
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  OrbitControls: () => null,
  Grid: () => null,
}));

import TheaterReadinessPosture, { FobLabel, PostureGrid } from '../TheaterReadinessPosture';

const composition = { sensors: 1, launchers: 0, facilities: 0, inflight: 0, other: 0 };

describe('FobLabel — HQ-ATTACHED tag', () => {
  it('shows the tag and the tooltip text when attachment is hq', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-03"
        total={1}
        composition={composition}
        attachment="hq"
      />
    );
    expect(html).toContain('HQ-ATTACHED');
    expect(html).toContain('Writes straight to HQ. No edge store: this is not edge data that survives a WAN cut.');
  });

  it('does not show the tag when attachment is tier', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-01"
        total={1}
        composition={composition}
        attachment="tier"
      />
    );
    expect(html).not.toContain('HQ-ATTACHED');
  });

  it('does not show the tag when attachment is undeclared (undefined)', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-02"
        total={1}
        composition={composition}
      />
    );
    expect(html).not.toContain('HQ-ATTACHED');
  });
});

describe('FobLabel — link state word', () => {
  const words: Array<[any, string]> = [
    [{ state: 'up', declaredIdle: false }, 'UP'],
    [{ state: 'idle', declaredIdle: false }, 'IDLE'],
    [{ state: 'idle', declaredIdle: true }, 'IDLE · declared'],
    [{ state: 'down', declaredIdle: false }, 'DOWN'],
    [{ state: 'unknown', declaredIdle: false }, 'UNKNOWN'],
  ];
  it.each(words)('renders %j as %s', (link, word) => {
    const html = renderToStaticMarkup(
      <FobLabel position={[0, 0, 0]} label="edge-01" total={1} composition={composition} link={link} />
    );
    expect(html).toContain(`data-link-state="${word}"`);
  });
});

describe('TheaterReadinessPosture — link card', () => {
  it('keeps the GLOBAL LINK STATUS summary and renders no per-link rows', () => {
    mockFobs.splice(0, mockFobs.length, { edge_id: 'edge-03', region_id: 'r1', lat: 1, lon: 1, name: 'f' });
    mockLinkStatus.mockReturnValue({
      links: new Map([['edge-03', {
        id: 'edge-03', link_state: 'up', traffic: 'none', declared_idle: false,
        heartbeat_age_s: 1, last_heartbeat_at: null, bridge_lag: 0,
        updated_at: new Date().toISOString(),
      }]]),
      isLoading: false, isError: false,
    });
    mockLinkControl.mockReturnValue({
      status: 'ready', uplink: null,
      children: [{ id: 'edge-03', enabled: true, toxics: null }],
      set: () => {}, setToxics: () => {},
    });
    const html = renderToStaticMarkup(<TheaterReadinessPosture />);
    mockFobs.splice(0, mockFobs.length);
    expect(html).toContain('GLOBAL LINK STATUS');
    expect(html).toContain('data-testid="link-chip-up" data-count="1"');
    expect(html).toContain('data-testid="link-chip-down" data-count="0"');
    expect(html).toContain('aria-label="1 UP · 0 IDLE · 0 DOWN"');
    expect(html).not.toContain('link-chip-unknown');
    expect(html).toContain('data-testid="hq-posture-hud"');
    expect(html).not.toContain('DIRECT LINKS');
    expect(html).not.toContain('link-toggle-');
  });
});

describe('TheaterReadinessPosture - tier tree', () => {
  it('chips total equals the drawn-edge count and a stray FOB is not drawn', () => {
    const f = (edge_id: string) => ({ edge_id, region_id: 'region-a', lat: 1, lon: 1, name: edge_id });
    mockFobs.splice(0, mockFobs.length, f('edge-a'), f('edge-b'), f('stray'));
    mockTiers.splice(0, mockTiers.length,
      { id: 'edge-a', parent: 'region-a', hasChildren: false },
      { id: 'edge-b', parent: 'region-a', hasChildren: false },
      { id: 'region-a', parent: 'root', hasChildren: true },
    );
    const mk = (id: string, state: string) => [id, {
      id, link_state: state, traffic: 'none', declared_idle: false,
      heartbeat_age_s: 1, last_heartbeat_at: null, bridge_lag: 0,
      updated_at: new Date().toISOString(),
    }] as const;
    mockLinkStatus.mockReturnValue({
      links: new Map([mk('edge-a', 'down'), mk('edge-b', 'down'), mk('region-a', 'down')]),
      isLoading: false, isError: false,
    });
    mockLinkControl.mockReturnValue({
      status: 'ready', uplink: null, children: [], set: () => {}, setToxics: () => {},
    });
    const html = renderToStaticMarkup(<TheaterReadinessPosture />);
    mockFobs.splice(0, mockFobs.length);
    mockTiers.splice(0, mockTiers.length);
    const counts = [...html.matchAll(/data-testid="link-chip-[a-z]+" data-count="(\d+)"/g)]
      .map((m) => Number(m[1]));
    const drawn = /data-testid="hq-topology" data-edge-count="(\d+)" data-node-ids="([^"]*)"/.exec(html);
    expect(drawn).not.toBeNull();
    expect(counts.reduce((a, b) => a + b, 0)).toBe(Number(drawn![1]));
    expect(drawn![1]).toBe('3');
    expect(drawn![2].split(',').sort()).toEqual(['edge-a', 'edge-b', 'region-a']);
    expect(html).not.toContain('stray');
    expect(html).toContain('data-testid="link-chip-unreachable" data-count="2"');
  });
});

describe('PostureGrid', () => {
  const r = (ready: number, degraded: number, offline: number, unknown: number) =>
    ({ ready, degraded, offline, unknown, total: ready + degraded + offline + unknown });
  const empty = r(0, 0, 0, 0);
  const rollups = (sensors: ReturnType<typeof r>) =>
    ({ sensors, launchers: r(1, 1, 0, 0), facilities: empty, inflight: empty, other: empty });

  it('renders an em dash for a zero severity and no UNK column when none unknown', () => {
    const h = renderToStaticMarkup(<PostureGrid rollups={rollups(r(3, 0, 0, 0))} />);
    expect(h).toContain('data-col="deg" class="text-right text-slate-700">—<');
    expect(h).toContain('data-col="rdy" class="text-right text-emerald-400">3<');
    expect(h).not.toContain('>UNK<');
    expect(h).not.toContain('data-col="unk"');
    expect(h).not.toContain('posture-row-facilities');
  });

  it('adds the UNK column when any row has unknown assets', () => {
    const h = renderToStaticMarkup(<PostureGrid rollups={rollups(r(3, 0, 0, 2))} />);
    expect(h).toContain('>UNK<');
    expect(h).toContain('repeat(5, 2.25rem)');
  });
});
