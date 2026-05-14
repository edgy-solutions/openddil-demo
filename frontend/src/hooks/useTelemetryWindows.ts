// useTelemetryWindows — rolling-window aggregations for one asset.
// Source: asset_telemetry_windows, filtered by asset_id.
//
// fluid_trends / consumable_trends / component_wear_trends are jsonb blobs
// mirroring the WindowedTelemetry proto (slope + latest + r_squared per
// signal). Used by per-asset trend charts.
import { num, useTableShape, sqlLiteral, type ShapeResult } from './electric';

export interface TelemetryWindows {
  asset_id: string;
  platform_variant: string | null;
  /** map<string, ScalarTrend> — keyed by fluid name (e.g. fuel_remaining). */
  fluid_trends: Record<string, any>;
  consumable_trends: any[];
  component_wear_trends: any[];
  window_duration_seconds: number | null;
  sample_count: number | null;
  computed_at: string | null;
}

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

function mapWindows(row: Record<string, any>): TelemetryWindows {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? null,
    fluid_trends: row.fluid_trends ?? {},
    consumable_trends: row.consumable_trends ?? [],
    component_wear_trends: row.component_wear_trends ?? [],
    window_duration_seconds: nullableNum(row.window_duration_seconds),
    sample_count: nullableNum(row.sample_count),
    computed_at: row.computed_at ?? null,
  };
}

/** Windowed telemetry for one asset. Returns at most one row in `data`. */
export function useTelemetryWindows(assetId: string): ShapeResult<TelemetryWindows> {
  return useTableShape('asset_telemetry_windows', mapWindows, {
    where: `asset_id = ${sqlLiteral(assetId)}`,
  });
}

/** Windowed telemetry for the whole fleet — for HQ wear-trend rollups. */
export function useAllTelemetryWindows(): ShapeResult<TelemetryWindows> {
  return useTableShape('asset_telemetry_windows', mapWindows);
}
