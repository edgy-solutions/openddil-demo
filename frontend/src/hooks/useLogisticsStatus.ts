// useLogisticsStatus — logistics severity for one asset.
// Source: asset_logistics_status, filtered by asset_id.
//
// overall_severity / previous_severity are proto enum string names.
// constraining_factors is a jsonb list of the factors pulling severity
// above OK. Envelope flags (is_transition, is_initial) distinguish a real
// severity change from a cadenced recompute.
import { num, useTableShape, sqlLiteral, type ShapeResult } from './electric';

export interface ConstrainingFactor {
  factor_id: string;
  severity: string;
  description?: string;
  current_value?: { value: number; unit: string };
  threshold?: { value: number; unit: string };
}

export interface LogisticsStatus {
  asset_id: string;
  platform_variant: string | null;
  /** LOGISTICS_SEVERITY_OK | _DEGRADED | _CRITICAL | _NON_OPERATIONAL | _UNSPECIFIED */
  overall_severity: string;
  previous_severity: string | null;
  constraining_factors: ConstrainingFactor[];
  projected_mission_capable_remaining_seconds: number | null;
  projected_time_to_next_constraint_seconds: number | null;
  cm_baseline_id: string | null;
  status_revision: number;
  computed_at: string | null;
  latest_telemetry_sample_time: string | null;
  is_transition: boolean;
  is_initial: boolean;
}

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

function mapLogistics(row: Record<string, any>): LogisticsStatus {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? null,
    overall_severity: row.overall_severity ?? 'LOGISTICS_SEVERITY_UNSPECIFIED',
    previous_severity: row.previous_severity ?? null,
    constraining_factors: row.constraining_factors ?? [],
    projected_mission_capable_remaining_seconds: nullableNum(
      row.projected_mission_capable_remaining_seconds,
    ),
    projected_time_to_next_constraint_seconds: nullableNum(
      row.projected_time_to_next_constraint_seconds,
    ),
    cm_baseline_id: row.cm_baseline_id ?? null,
    status_revision: num(row.status_revision),
    computed_at: row.computed_at ?? null,
    latest_telemetry_sample_time: row.latest_telemetry_sample_time ?? null,
    // Electric returns booleans as the literal strings "t"/"f".
    is_transition: row.is_transition === true || row.is_transition === 't',
    is_initial: row.is_initial === true || row.is_initial === 't',
  };
}

/** Logistics status for one asset. Returns at most one row in `data`. */
export function useLogisticsStatus(assetId: string): ShapeResult<LogisticsStatus> {
  return useTableShape('asset_logistics_status', mapLogistics, {
    where: `asset_id = ${sqlLiteral(assetId)}`,
  });
}

/** Logistics status for the whole fleet — for regional / HQ aggregation. */
export function useAllLogisticsStatus(): ShapeResult<LogisticsStatus> {
  return useTableShape('asset_logistics_status', mapLogistics);
}
