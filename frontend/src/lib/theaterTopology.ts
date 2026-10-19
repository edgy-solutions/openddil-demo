// The HQ theater's drawn topology: which tiers are nodes, which links are
// edges, and what state each edge reads. Pure -- no React, no three, no clock
// of its own (callers pass `nowMs`).
//
// With the chart's tier tree (deployment.json `tiers`):
//   * a tier is drawn if a FOB places it (fob.edge_id === tier.id), at the FOB;
//   * else, if the site table has a tier_sites row for it (tier_id === tier.id),
//     at that site (not derived): a region's own declared position;
//   * a tier with neither but a drawn child is drawn at the mean of its drawn
//     children (`derived`), so a region needs no coordinates of its own;
//   * any other tier, and any FOB that is not a tier, is not drawn.
// One edge per drawn tier runs to its parent's node, or to HQ when the parent
// is not a drawn tier (root, hq, absent, not drawn).
//
// An edge's own state is the header's own classification (linkForFob). HQ's
// link_status is measured by heartbeat arrival along the data path, so a child
// under a cut ancestor goes silent at HQ: it is UNREACHABLE through that
// ancestor, not itself DOWN.
//
// Without a tier tree: today's picture, one edge per FOB straight to HQ.
import type { Fob, TierEntry, TierSite } from '../deployment';
import {
  linkForFob,
  summarizeLinks,
  type LinkCounts,
  type LinkReading,
  type LinkState,
  type LinkStatusRow,
} from './linkStatus';

export const HQ_NODE = 'hq';

export type EdgeState = LinkState | 'unreachable';

export interface TopoNode {
  id: string;
  lat: number;
  lon: number;
  /** Placed at the mean of its drawn children rather than at a FOB. */
  derived: boolean;
  /** The tier rolls up children (drawn as a region marker). */
  hasChildren: boolean;
  /** The FOB that places this node; absent when derived. */
  fob?: Fob;
}

export interface TopoEdge {
  /** The tier this edge belongs to (its child end). */
  id: string;
  /** Parent node id, or HQ_NODE. */
  to: string;
  /** This edge's own reading from link_status. */
  reading: LinkReading;
  /** Own state, or 'unreachable' when an ancestor edge is down. */
  state: EdgeState;
  /** Nearest down ancestor, when state is 'unreachable'. */
  via?: string;
}

export interface TopologyCounts extends LinkCounts {
  unreachable: number;
}

export interface TheaterTopology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  counts: TopologyCounts;
}

function countEdges(edges: readonly TopoEdge[]): TopologyCounts {
  const own = edges.filter((e) => e.state !== 'unreachable').map((e) => ({
    ...e.reading, state: e.state as LinkState,
  }));
  return { ...summarizeLinks(own), unreachable: edges.length - own.length };
}

export function buildTheaterTopology(
  tiers: readonly TierEntry[] | undefined,
  fobs: readonly Fob[],
  linkRows: ReadonlyMap<string, LinkStatusRow>,
  nowMs: number,
  sites?: readonly TierSite[],
): TheaterTopology {
  if (!tiers || tiers.length === 0) {
    const nodes: TopoNode[] = fobs.map((f) => ({
      id: f.edge_id, lat: f.lat, lon: f.lon, derived: false, hasChildren: false, fob: f,
    }));
    const edges: TopoEdge[] = fobs.map((f) => {
      const reading = linkForFob(linkRows, f.edge_id, nowMs);
      return { id: f.edge_id, to: HQ_NODE, reading, state: reading.state };
    });
    return { nodes, edges, counts: countEdges(edges) };
  }

  const byId = new Map<string, TierEntry>();
  for (const t of tiers) if (!byId.has(t.id)) byId.set(t.id, t);
  const fobOf = new Map<string, Fob>();
  for (const f of fobs) if (byId.has(f.edge_id) && !fobOf.has(f.edge_id)) fobOf.set(f.edge_id, f);
  const siteOf = new Map<string, TierSite>();
  for (const s of sites ?? []) if (!siteOf.has(s.tier_id)) siteOf.set(s.tier_id, s);
  const childrenOf = new Map<string, string[]>();
  for (const t of byId.values()) {
    if (t.parent && t.parent !== t.id && byId.has(t.parent)) {
      const l = childrenOf.get(t.parent) ?? [];
      l.push(t.id);
      childrenOf.set(t.parent, l);
    }
  }

  // Resolve each tier's node, children first. `visiting` guards a cyclic tree.
  const placed = new Map<string, TopoNode | null>();
  const visiting = new Set<string>();
  const place = (id: string): TopoNode | null => {
    if (placed.has(id)) return placed.get(id)!;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const tier = byId.get(id)!;
    const f = fobOf.get(id);
    let node: TopoNode | null = null;
    if (f) {
      node = { id, lat: f.lat, lon: f.lon, derived: false, hasChildren: tier.hasChildren, fob: f };
    } else if (siteOf.has(id)) {
      const s = siteOf.get(id)!;
      node = { id, lat: s.lat, lon: s.lon, derived: false, hasChildren: tier.hasChildren };
    } else {
      const kids = (childrenOf.get(id) ?? []).map(place).filter((n): n is TopoNode => n !== null);
      if (kids.length > 0) {
        node = {
          id,
          lat: kids.reduce((s, k) => s + k.lat, 0) / kids.length,
          lon: kids.reduce((s, k) => s + k.lon, 0) / kids.length,
          derived: true,
          hasChildren: true,
        };
      }
    }
    visiting.delete(id);
    placed.set(id, node);
    return node;
  };

  const nodes: TopoNode[] = [];
  for (const t of byId.values()) {
    const n = place(t.id);
    if (n) nodes.push(n);
  }
  const drawn = new Set(nodes.map((n) => n.id));

  const parentOf = (id: string): string => {
    const p = byId.get(id)!.parent;
    return p && p !== id && drawn.has(p) ? p : HQ_NODE;
  };
  const own = new Map<string, LinkReading>();
  for (const n of nodes) own.set(n.id, linkForFob(linkRows, n.id, nowMs));

  const edges: TopoEdge[] = nodes.map((n) => {
    const reading = own.get(n.id)!;
    // Walk up to HQ; the nearest ancestor whose own edge is down cuts us off.
    const seen = new Set<string>([n.id]);
    let via: string | undefined;
    for (let p = parentOf(n.id); p !== HQ_NODE && !seen.has(p); p = parentOf(p)) {
      seen.add(p);
      if (own.get(p)!.state === 'down') { via = p; break; }
    }
    return via
      ? { id: n.id, to: parentOf(n.id), reading, state: 'unreachable', via }
      : { id: n.id, to: parentOf(n.id), reading, state: reading.state };
  });
  return { nodes, edges, counts: countEdges(edges) };
}
