/** Grouping of map items that sit at (nearly) the same scene position. */
export type Placed<K> = { key: K; pos: [number, number] };

export type SiteGroup<K> = { pos: [number, number]; keys: K[] };

/**
 * Single-link grouping: two items share a group when they are within `eps`
 * (Euclidean) of each other, chained. A group's `pos` is the `pos` of its first
 * item in input order; groups are ordered by their first item, `keys` keep
 * input order.
 */
export function groupByPosition<K>(items: Placed<K>[], eps: number): SiteGroup<K>[] {
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = items[i].pos[0] - items[j].pos[0];
      const dz = items[i].pos[1] - items[j].pos[1];
      if (Math.hypot(dx, dz) <= eps) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const byRoot = new Map<number, SiteGroup<K>>();
  const out: SiteGroup<K>[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = byRoot.get(r);
    if (!g) {
      g = { pos: items[i].pos, keys: [] };
      byRoot.set(r, g);
      out.push(g);
    }
    g.keys.push(items[i].key);
  }
  return out;
}
