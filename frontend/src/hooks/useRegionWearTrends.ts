// useRegionWearTrends — Phase 6c.1 hook for the region_wear_trends table.
// Populated by the projector's region_wear_trends handler from faust-
// regional's RegionWearTrends emits. One row per region; the components
// JSONB array is keyed by (component_id, unit) per the mixed-unit
// handling rule (Q3) — the same component_id can appear MULTIPLE times
// with different units; the UI must render each (component_id, unit) row
// distinctly and NEVER cross-unit-mean.
//
// ASYMMETRIC COVERAGE (recipe-greenlit pre-§B build, still in force):
// faust-regional aggregates from derived-sustainment only in §B. The
// asset-telemetry-windows path is wired in the fan-in envelope but does
// NOT drive emissions (follow-up #11 closes that gap). UI consumers see
// derived-only wear trends; this is honest, not partial.
//
// Cold-start: empty until faust-regional sees at least one derived-
// sustainment event for an asset in the region. Panel renders "Awaiting
// first emission — no wear components observed yet" in that gap.
import { num, useTableShape, type ShapeResult } from './electric';

export interface ComponentWearTrend {
  component_id: string;
  unit: string;
  mean_rul_remaining: number;
  asset_count: number;
}

export interface RegionWearTrends {
  region_id: string;
  components: ComponentWearTrend[];
  observed_at: string | null;
}

function mapRow(row: Record<string, any>): RegionWearTrends {
  const raw = (row.components ?? []) as Array<Record<string, any>>;
  return {
    region_id: row.region_id,
    components: raw.map((c) => ({
      component_id: c.component_id ?? c.componentId ?? '',
      unit: c.unit ?? '',
      mean_rul_remaining: num(c.mean_rul_remaining ?? c.meanRulRemaining),
      asset_count: num(c.asset_count ?? c.assetCount),
    })),
    observed_at: row.observed_at ?? null,
  };
}

export function useRegionWearTrends(): ShapeResult<RegionWearTrends> {
  return useTableShape('region_wear_trends', mapRow);
}
