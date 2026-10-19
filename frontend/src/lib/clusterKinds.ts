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
