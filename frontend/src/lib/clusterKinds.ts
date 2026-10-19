// What a clustered group of co-located assets shows: one symbol per kind.

/** Most kinds a cluster draws; past that, the top MAX_KINDS-1 plus a "+N more" chip. */
export const MAX_KINDS = 4;

export const SEV_RANK: Record<string, number> = {
  LOGISTICS_SEVERITY_OK: 0,
  LOGISTICS_SEVERITY_DEGRADED: 1,
  LOGISTICS_SEVERITY_CRITICAL: 2,
  LOGISTICS_SEVERITY_NON_OPERATIONAL: 3,
};

/** Shooters (0), then sensors (1), then command (2), then everything else (3); no variant last (4). */
export function roleOf(v: string | null): number {
  if (!v) return 4;
  if (/_(interceptor|launcher)$/i.test(v) || /^(MISSILE_LAUNCHER|M1A2|AH-64)/i.test(v)) return 0;
  if (/_(sensor|radar)$/i.test(v)) return 1;
  if (/^(HEADQUARTER_COMPLEX|AIR_DEFENSE_SITE)$/.test(v)) return 2;
  return 3;
}

export interface KindMember { variant: string | null; severity: string }
export interface Kind<T extends KindMember> {
  variant: string | null;
  members: T[];
  /** The worst severity among the members. */
  sev: string;
}

/** Kinds of a cluster, ordered, with the overflow beyond MAX_KINDS in `hidden`. */
export function kindsOf<T extends KindMember>(members: T[]): { shown: Kind<T>[]; hidden: Kind<T>[] } {
  const by = new Map<string, T[]>();
  for (const a of members) by.set(a.variant ?? '', [...(by.get(a.variant ?? '') ?? []), a]);
  const kinds: Kind<T>[] = [...by.values()].map((m) => ({
    variant: m[0].variant,
    members: m,
    sev: m.map((x) => x.severity).reduce((w, x) => ((SEV_RANK[x] ?? 0) > (SEV_RANK[w] ?? 0) ? x : w)),
  }));
  const order = (x: Kind<T>, y: Kind<T>) => roleOf(x.variant) - roleOf(y.variant)
    || y.members.length - x.members.length || (x.variant ?? '').localeCompare(y.variant ?? '');
  if (kinds.length <= MAX_KINDS) return { shown: kinds.sort(order), hidden: [] };
  // A faulted kind is never hidden behind the chip.
  const faulted = (k: Kind<T>) => (SEV_RANK[k.sev] ?? 0) > 0;
  const pick = [...kinds].sort((x, y) => Number(faulted(y)) - Number(faulted(x)) || order(x, y));
  return { shown: pick.slice(0, MAX_KINDS - 1).sort(order), hidden: pick.slice(MAX_KINDS - 1).sort(order) };
}

/**
 * Whether a cluster should be drawn split into its members. `clustered` is the
 * current state; `minSep` the least distance between two members and `rSym` the
 * symbol radius, both in world units. Split once the members clear 2.4 symbol
 * radii; cluster again only below 2.0, so it does not flicker at the boundary.
 * Members at one coordinate (minSep 0) never split.
 */
export function shouldSplit(clustered: boolean, minSep: number, rSym: number): boolean {
  const stillClustered = clustered ? minSep < 2.4 * rSym : minSep < 2.0 * rSym;
  return !stillClustered;
}

export interface MstEdge { a: number; b: number; len: number }

/** Euclidean minimum spanning tree of ground-plane points (x, z). Dense Prim, O(n^2). */
export function mstEdges(points: [number, number][]): MstEdge[] {
  const n = points.length;
  if (n <= 1) return [];
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(0);
  const out: MstEdge[] = [];
  inTree[0] = true;
  for (let j = 1; j < n; j++) best[j] = Math.hypot(points[j][0] - points[0][0], points[j][1] - points[0][1]);
  for (let k = 1; k < n; k++) {
    let u = -1;
    for (let j = 0; j < n; j++) if (!inTree[j] && (u < 0 || best[j] < best[u])) u = j;
    inTree[u] = true;
    out.push({ a: from[u], b: u, len: best[u] });
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const d = Math.hypot(points[j][0] - points[u][0], points[j][1] - points[u][1]);
      if (d < best[j]) { best[j] = d; from[j] = u; }
    }
  }
  return out;
}

/**
 * Whether an MST edge is merged (its two ends drawn as one cluster). A merged edge
 * stays merged while `len < 2.4 * rSym`; an unmerged or unknown one merges below
 * 2.0 * rSym. Matches `shouldSplit`'s hysteresis. Coincident members (len 0) always merge.
 */
export function nextMerged(wasMerged: boolean | undefined, len: number, rSym: number): boolean {
  return len < (wasMerged ? 2.4 : 2.0) * rSym;
}

/** Member index groups from the merged edges (union-find). Each sorted ascending; groups by first index. */
export function groupsOf(n: number, edges: MstEdge[], merged: boolean[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  edges.forEach((e, i) => { if (merged[i]) parent[find(e.a)] = find(e.b); });
  const by = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = by.get(r);
    if (g) g.push(i); else by.set(r, [i]);
  }
  return [...by.values()].sort((x, y) => x[0] - y[0]);
}

/** Fraction of a thing's colour that survives exponential-squared fog (three's FogExp2: 1 - this is the fog mix). */
export function fogVisibility(density: number, distance: number): number {
  return Math.exp(-((density * distance) ** 2));
}
