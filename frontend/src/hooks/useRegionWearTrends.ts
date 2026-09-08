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
  /** True when more than one class partial was merged. The means below are
   *  then WEIGHTED across partials — exact only because each partial carries
   *  its own asset_count. Render the flag anyway: a weighted mean of
   *  truncated per-class component sets can still be missing components that
   *  appear in neither partial's list. */
  merged_lossy: boolean;
  partial_count: number;
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
    merged_lossy: false,
    partial_count: 1,
  };
}

export function useRegionWearTrends(): ShapeResult<RegionWearTrends> {
  const raw = useTableShape<RegionWearTrends>('region_wear_trends', mapRow);

  const byRegion = new Map<string, RegionWearTrends>();
  for (const p of raw.data) {
    const acc = byRegion.get(p.region_id);
    if (!acc) {
      byRegion.set(p.region_id, { ...p, components: p.components.map((c) => ({ ...c })), partial_count: 1, merged_lossy: false });
      continue;
    }
    const idx = new Map(acc.components.map((c) => [c.component_id, c]));
    for (const c of p.components) {
      const hit = idx.get(c.component_id);
      if (!hit) { acc.components.push({ ...c }); idx.set(c.component_id, acc.components[acc.components.length - 1]); continue; }
      // WEIGHTED mean, not the mean of means. Each partial carries its own
      // asset_count precisely so this merge is possible; averaging the
      // averages would let a class of one asset outweigh a class of thirteen.
      const total = hit.asset_count + c.asset_count;
      hit.mean_rul_remaining = total > 0
        ? (hit.mean_rul_remaining * hit.asset_count + c.mean_rul_remaining * c.asset_count) / total
        : 0;
      hit.asset_count = total;
    }
    acc.partial_count += 1;
    acc.merged_lossy = true;
    if (p.observed_at && (!acc.observed_at || p.observed_at < acc.observed_at)) {
      acc.observed_at = p.observed_at;
    }
  }

  return { ...raw, data: Array.from(byRegion.values()) };
}
