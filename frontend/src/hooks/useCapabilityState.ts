// useCapabilityState -- weapons-capability snapshot for one asset.
// Source: asset_capability_state, filtered by asset_id.
//
// Source-specific weapons-capability messages (customer-overlay AMQP,
// DIS Fire/Munition PDU derivations, AFSim stores extractions, Link 16
// J3.7 weapon status, etc.) are decomposed by their respective Bloblang
// into the JSONB `capabilities` array. Each entry is one weapon/store
// on the asset: ammo count, capability id, accepted interfaces, store
// metadata.
//
// Same shape pattern as useCmState. Returns at most one row per asset.
import { useTableShape, sqlLiteral, type ShapeResult } from './electric';

/** One weapon/store entry in capabilities[]. Flat JSON from Bloblang. */
export interface CapabilityStore {
  capability_id: string;
  ammo: number;
  store_category?: string;
  store_location?: number;
  accepted_interface?: string[];
  interrupt_other_activities?: boolean;
  simulated?: boolean;
  /** Anything else the customer message carries gets passed through. */
  [k: string]: any;
}

export interface CapabilityState {
  asset_id: string;
  capabilities: CapabilityStore[];
  schema_version: string | null;
  mode: string | null;
  edge_id: string;
  region_id: string;
  observed_at: string | null;
  updated_at: string;
}

function mapCapabilityState(row: Record<string, any>): CapabilityState {
  return {
    asset_id: row.asset_id,
    capabilities: row.capabilities ?? [],
    schema_version: row.schema_version ?? null,
    mode: row.mode ?? null,
    edge_id: row.edge_id ?? '',
    region_id: row.region_id ?? '',
    observed_at: row.observed_at ?? null,
    updated_at: row.updated_at,
  };
}

/** Capability state for one asset. Returns at most one row in `data`. */
export function useCapabilityState(assetId: string): ShapeResult<CapabilityState> {
  return useTableShape('asset_capability_state', mapCapabilityState, {
    where: `asset_id = ${sqlLiteral(assetId)}`,
  });
}

/** Capability state for the whole fleet -- for regional / HQ aggregation. */
export function useAllCapabilityState(): ShapeResult<CapabilityState> {
  return useTableShape('asset_capability_state', mapCapabilityState);
}
