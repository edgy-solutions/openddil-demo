import { describe, expect, it } from 'vitest';
import { buildTheaterTopology } from '../theaterTopology';
import { classifyLink, linkForFob, summarizeLinks, type LinkStatusRow } from '../linkStatus';
import type { Fob, TierEntry, TierSite } from '../../deployment';

const NOW = Date.parse('2026-10-08T12:00:30Z');
const fresh = '2026-10-08T12:00:28Z';

function row(id: string, state = 'up', over: Partial<LinkStatusRow> = {}): LinkStatusRow {
  return {
    id,
    link_state: state,
    traffic: 'active',
    declared_idle: false,
    heartbeat_age_s: 1,
    last_heartbeat_at: fresh,
    bridge_lag: 0,
    updated_at: fresh,
    ...over,
  };
}

function rows(states: Record<string, string>): Map<string, LinkStatusRow> {
  return new Map(Object.entries(states).map(([id, s]) => [id, row(id, s)]));
}

const fob = (edge_id: string, lat: number, lon: number): Fob => ({
  edge_id, region_id: 'region-a', lat, lon,
});

// root <- region-a <- {edge-a, edge-b}; edge-c -> root.
const TIERS: TierEntry[] = [
  { id: 'edge-a', parent: 'region-a', hasChildren: false },
  { id: 'edge-b', parent: 'region-a', hasChildren: false },
  { id: 'edge-c', parent: 'root', hasChildren: false },
  { id: 'region-a', parent: 'root', hasChildren: true },
];
const FOBS: Fob[] = [
  fob('edge-a', 2, 4),
  fob('edge-b', 4, 8),
  fob('edge-c', 9, 1),
  fob('stray', 5, 5),
];
const ALL_UP = { 'edge-a': 'up', 'edge-b': 'up', 'edge-c': 'up', 'region-a': 'up' };

const edgeOf = (t: ReturnType<typeof buildTheaterTopology>, id: string) =>
  t.edges.find((e) => e.id === id)!;

describe('buildTheaterTopology - tree', () => {
  it('(a) draws tiers, derives the region at the mean of its children, skips a stray FOB', () => {
    const t = buildTheaterTopology(TIERS, FOBS, rows(ALL_UP), NOW);
    expect(t.nodes.map((n) => n.id).sort()).toEqual(['edge-a', 'edge-b', 'edge-c', 'region-a']);
    const region = t.nodes.find((n) => n.id === 'region-a')!;
    expect(region.derived).toBe(true);
    expect(region.lat).toBeCloseTo(3);
    expect(region.lon).toBeCloseTo(6);
    expect(t.nodes.find((n) => n.id === 'edge-a')!.derived).toBe(false);
    expect(t.nodes.some((n) => n.id === 'stray')).toBe(false);
    expect(t.edges.map((e) => `${e.id}>${e.to}`).sort()).toEqual([
      'edge-a>region-a', 'edge-b>region-a', 'edge-c>hq', 'region-a>hq',
    ]);
  });

  it('(b) one child edge down reads DOWN only on that edge', () => {
    const t = buildTheaterTopology(TIERS, FOBS, rows({ ...ALL_UP, 'edge-a': 'down' }), NOW);
    expect(edgeOf(t, 'edge-a').state).toBe('down');
    expect(t.edges.filter((e) => e.state === 'up')).toHaveLength(3);
    expect(t.counts).toMatchObject({ up: 3, down: 1, unreachable: 0 });
    expect(t.counts.up + t.counts.idle + t.counts.down + t.counts.unknown + t.counts.unreachable)
      .toBe(t.edges.length);
  });

  it('(c) a down region makes its children unreachable via the region, not DOWN', () => {
    const t = buildTheaterTopology(
      TIERS, FOBS,
      rows({ 'edge-a': 'down', 'edge-b': 'down', 'edge-c': 'up', 'region-a': 'down' }),
      NOW,
    );
    expect(edgeOf(t, 'region-a').state).toBe('down');
    expect(edgeOf(t, 'edge-a')).toMatchObject({ state: 'unreachable', via: 'region-a' });
    expect(edgeOf(t, 'edge-b')).toMatchObject({ state: 'unreachable', via: 'region-a' });
    expect(edgeOf(t, 'edge-c').state).toBe('up');
    expect(t.counts).toMatchObject({ down: 1, unreachable: 2, up: 1 });
    expect(t.counts.up + t.counts.idle + t.counts.down + t.counts.unknown + t.counts.unreachable)
      .toBe(t.edges.length);
  });

  it('(d) a FOB for the region places it there, not derived', () => {
    const t = buildTheaterTopology(TIERS, [...FOBS, fob('region-a', 7, 7)], rows(ALL_UP), NOW);
    const region = t.nodes.find((n) => n.id === 'region-a')!;
    expect(region.derived).toBe(false);
    expect([region.lat, region.lon]).toEqual([7, 7]);
  });

  it('(g) a site row places a region there, not at the mean, not derived', () => {
    const sites: TierSite[] = [{ tier_id: 'region-a', lat: 30, lon: 40 }];
    const t = buildTheaterTopology(TIERS, FOBS, rows(ALL_UP), NOW, sites);
    const region = t.nodes.find((n) => n.id === 'region-a')!;
    expect(region.derived).toBe(false);
    expect(region.fob).toBeUndefined();
    expect([region.lat, region.lon]).toEqual([30, 40]);
  });

  it('(h) a region with no site row is still the mean of its children', () => {
    const sites: TierSite[] = [{ tier_id: 'elsewhere', lat: 30, lon: 40 }];
    const t = buildTheaterTopology(TIERS, FOBS, rows(ALL_UP), NOW, sites);
    const region = t.nodes.find((n) => n.id === 'region-a')!;
    expect(region.derived).toBe(true);
    expect([region.lat, region.lon]).toEqual([3, 6]);
  });

  it('(i) a FOB outranks a site row for the same tier', () => {
    const sites: TierSite[] = [{ tier_id: 'region-a', lat: 30, lon: 40 }];
    const t = buildTheaterTopology(TIERS, [...FOBS, fob('region-a', 7, 7)], rows(ALL_UP), NOW, sites);
    const region = t.nodes.find((n) => n.id === 'region-a')!;
    expect([region.lat, region.lon]).toEqual([7, 7]);
    expect(region.fob).toBeDefined();
  });

  it('(f) a stale row reads exactly as the header classifies it', () => {
    const stale = row('edge-c', 'up', { updated_at: '2026-10-08T11:00:00Z' });
    const m = rows(ALL_UP);
    m.set('edge-c', stale);
    const t = buildTheaterTopology(TIERS, FOBS, m, NOW);
    expect(classifyLink(stale, NOW).state).toBe('unknown');
    expect(edgeOf(t, 'edge-c').state).toBe('unknown');
    expect(edgeOf(t, 'edge-c').reading).toEqual(classifyLink(stale, NOW));
    expect(t.counts.unknown).toBe(1);
  });
});

describe('buildTheaterTopology - no tiers', () => {
  it('(e) falls back to one edge to HQ per FOB, with today\'s counts', () => {
    const m = rows({ 'edge-a': 'up', 'edge-b': 'down', 'edge-c': 'idle' });
    const t = buildTheaterTopology(undefined, FOBS, m, NOW);
    expect(t.nodes.map((n) => n.id)).toEqual(['edge-a', 'edge-b', 'edge-c', 'stray']);
    expect(t.edges.map((e) => e.to)).toEqual(['hq', 'hq', 'hq', 'hq']);
    const today = FOBS.map((f) => linkForFob(m, f.edge_id, NOW));
    expect(t.edges.map((e) => e.reading)).toEqual(today);
    expect(t.counts).toEqual({ ...summarizeLinks(today), unreachable: 0 });
  });
});
