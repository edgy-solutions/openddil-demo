// useRegionTopFactors — Phase 6c.1 hook for the region_top_factors table.
// Populated by the projector's region_top_factors handler from faust-
// regional's RegionTopFactors emits. One row per region; the factors
// JSONB column carries [{factor_id, count, severity_breakdown}], sorted
// DESC by count, top-N truncated at the aggregator (default N=10).
//
// Empty under cold start — faust-regional skips emit when no factors
// observed; the UI cold-state renders "Awaiting first emission — no
// factors observed yet" (locked in pre-§A as the cold-start disposition).
import { num, useTableShape, type ShapeResult } from './electric';

export interface RegionFactor {
  factor_id: string;
  count: number;
  /** Map of LogisticsSeverity name (UNSPECIFIED/OK/DEGRADED/CRITICAL/
   *  NON_OPERATIONAL) -> count. Sum equals `count`. */
  severity_breakdown: Record<string, number>;
}

export interface RegionTopFactors {
  region_id: string;
  factors: RegionFactor[];
  observed_at: string | null;
  /** True when more than one class partial was merged — the ranking is then
   *  approximate and the tail incomplete. Render it. */
  merged_lossy: boolean;
  partial_count: number;
}

function mapRow(row: Record<string, any>): RegionTopFactors {
  const raw = (row.factors ?? []) as Array<Record<string, any>>;
  return {
    region_id: row.region_id,
    factors: raw.map((f) => ({
      factor_id: f.factor_id ?? f.factorId ?? '',
      count: num(f.count),
      severity_breakdown: (f.severity_breakdown ?? f.severityBreakdown ?? {}) as Record<string, number>,
    })),
    observed_at: row.observed_at ?? null,
    merged_lossy: false,
    partial_count: 1,
  };
}

/**
 * MERGING PARTIALS IS LOSSY HERE, and that is GD-05 stated per class rather
 * than hidden. The aggregator emits one partial per releasability class and
 * truncates each to top-N. A per-class top-10 merged with another per-class
 * top-10 is NOT the top-10 of the union: a factor ranked 11th in both classes
 * outranks one ranked 1st in a class of two assets, and neither partial
 * carries it. Counts for factors that DO appear are exact (the classes
 * partition the contributors); the RANKING is approximate, and the tail is
 * missing rather than zero.
 *
 * Rendered with `merged_lossy` so the panel can say so. Showing an
 * approximate ranking as though it were exact is the failure this project
 * keeps recording under a different name each time.
 */
export function useRegionTopFactors(): ShapeResult<RegionTopFactors> {
  const raw = useTableShape<RegionTopFactors>('region_top_factors', mapRow);

  const byRegion = new Map<string, RegionTopFactors>();
  for (const p of raw.data) {
    const acc = byRegion.get(p.region_id);
    if (!acc) {
      byRegion.set(p.region_id, { ...p, factors: [...p.factors], partial_count: 1, merged_lossy: false });
      continue;
    }
    const idx = new Map(acc.factors.map((f) => [f.factor_id, f]));
    for (const f of p.factors) {
      const hit = idx.get(f.factor_id);
      if (!hit) {
        acc.factors.push({ ...f, severity_breakdown: { ...f.severity_breakdown } });
        idx.set(f.factor_id, acc.factors[acc.factors.length - 1]);
        continue;
      }
      // Counts for a factor present in both partials ADD exactly: the classes
      // partition the contributors, so no asset is counted twice.
      hit.count += f.count;
      for (const [sev, n] of Object.entries(f.severity_breakdown)) {
        hit.severity_breakdown[sev] = (hit.severity_breakdown[sev] ?? 0) + n;
      }
    }
    acc.partial_count += 1;
    acc.merged_lossy = true;
    if (p.observed_at && (!acc.observed_at || p.observed_at < acc.observed_at)) {
      acc.observed_at = p.observed_at;
    }
  }
  for (const r of byRegion.values()) r.factors.sort((a, b) => b.count - a.count);

  return { ...raw, data: Array.from(byRegion.values()) };
}
