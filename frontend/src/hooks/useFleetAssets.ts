// useFleetAssets — every asset the pipeline has seen telemetry for.
// Backs the fleet picker / asset list. Source: telemetry_latest_state.
import { num, useTableShape, type ShapeResult } from './electric';

export interface FleetAsset {
  asset_id: string;
  platform_variant: string | null;
  callsign: string | null;
  force_id: string | null;
  last_sample_at: string | null;
  schema_revision: number;
}

function mapFleetAsset(row: Record<string, any>): FleetAsset {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? null,
    callsign: row.callsign ?? null,
    force_id: row.force_id ?? null,
    last_sample_at: row.last_sample_at ?? null,
    schema_revision: num(row.schema_revision),
  };
}

export function useFleetAssets(): ShapeResult<FleetAsset> {
  return useTableShape('telemetry_latest_state', mapFleetAsset);
}
