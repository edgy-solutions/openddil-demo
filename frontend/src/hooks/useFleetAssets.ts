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
  // ADR-0023 Phase 6a: per-asset edge attribution. Comes from
  // telemetry_latest_state.edge_id / region_id, which the projector's
  // telemetry_latest handler now reads from the message-field
  // Provenance (env-default fallback when missing). Used by the
  // EDGE ATTRIBUTION panel on the HQ view.
  edge_id: string | null;
  region_id: string | null;
}

function mapFleetAsset(row: Record<string, any>): FleetAsset {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? null,
    callsign: row.callsign ?? null,
    force_id: row.force_id ?? null,
    last_sample_at: row.last_sample_at ?? null,
    schema_revision: num(row.schema_revision),
    edge_id: row.edge_id ?? null,
    region_id: row.region_id ?? null,
  };
}

export function useFleetAssets(): ShapeResult<FleetAsset> {
  return useTableShape('telemetry_latest_state', mapFleetAsset);
}
