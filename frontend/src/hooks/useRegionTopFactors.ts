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
  };
}

export function useRegionTopFactors(): ShapeResult<RegionTopFactors> {
  return useTableShape('region_top_factors', mapRow);
}
