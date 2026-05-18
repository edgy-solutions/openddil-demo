// useRegionFleetSummary — Phase 6b §B observable checkpoint hook.
// Reads region_fleet_summary, populated by the projector's
// region_fleet_summary handler from faust-regional's RegionFleetSummary
// emits. One row per region; backs the REGION FLEET SUMMARY panel.
import { num, useTableShape, type ShapeResult } from './electric';

export interface RegionFleetSummary {
  region_id: string;
  nominal: number;
  degraded: number;
  critical: number;
  non_operational: number;
  asset_count: number;
  observed_at: string | null;
}

function mapRow(row: Record<string, any>): RegionFleetSummary {
  return {
    region_id: row.region_id,
    nominal: num(row.nominal),
    degraded: num(row.degraded),
    critical: num(row.critical),
    non_operational: num(row.non_operational),
    asset_count: num(row.asset_count),
    observed_at: row.observed_at ?? null,
  };
}

export function useRegionFleetSummary(): ShapeResult<RegionFleetSummary> {
  return useTableShape('region_fleet_summary', mapRow);
}
