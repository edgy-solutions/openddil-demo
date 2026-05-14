// useCmState — Configuration Management state for one asset.
// Source: asset_cm_state, filtered by asset_id.
//
// Enum columns (lifecycle, overall_status) arrive as proto string names —
// the projector's cm_state handler maps cm-service's integer enums back to
// names (see ADR-0018). discrepancies / manual_discrepancies are separate
// jsonb lists (ADR-0009): analyzer-rebuilt vs human-raised.
import { useTableShape, type ShapeResult } from './electric';

export interface CmState {
  asset_id: string;
  baseline_id: string | null;
  /** LIFECYCLE_REGISTERED | _ACTIVE | _STALE | _DECOMMISSIONED | _UNSPECIFIED */
  lifecycle: string;
  /** CONFIG_STATUS_IN_COMPLIANCE | _MINOR_DISCREPANCY | _MAJOR_DISCREPANCY | _NOT_MISSION_CAPABLE | _UNSPECIFIED */
  overall_status: string;
  last_alerted_status: string | null;
  as_of: string | null;
  last_observed_at: string | null;
  installed: any[];
  mod_status: any[];
  discrepancies: any[];
  manual_discrepancies: any[];
}

function mapCmState(row: Record<string, any>): CmState {
  return {
    asset_id: row.asset_id,
    baseline_id: row.baseline_id ?? null,
    lifecycle: row.lifecycle ?? 'LIFECYCLE_UNSPECIFIED',
    overall_status: row.overall_status ?? 'CONFIG_STATUS_UNSPECIFIED',
    last_alerted_status: row.last_alerted_status ?? null,
    as_of: row.as_of ?? null,
    last_observed_at: row.last_observed_at ?? null,
    installed: row.installed ?? [],
    mod_status: row.mod_status ?? [],
    discrepancies: row.discrepancies ?? [],
    manual_discrepancies: row.manual_discrepancies ?? [],
  };
}

/** CM state for one asset. Returns at most one row in `data`. */
export function useCmState(assetId: string): ShapeResult<CmState> {
  return useTableShape('asset_cm_state', mapCmState, {
    where: 'asset_id = $1',
    params: { 1: assetId },
  });
}

/** CM state for the whole fleet — for regional / HQ aggregation. */
export function useAllCmState(): ShapeResult<CmState> {
  return useTableShape('asset_cm_state', mapCmState);
}
