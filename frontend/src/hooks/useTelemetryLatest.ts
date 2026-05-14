// useTelemetryLatest — the latest telemetry snapshot for one asset.
// Source: telemetry_latest_state, filtered by asset_id.
//
// kinematics / sustainment / provenance are jsonb blobs mirroring the
// EntityTelemetryEvent proto. Quantity-typed leaves arrive as
// { value, unit } objects (ADR-0013) — consumers read `.value` for the
// number and `.unit` for the label.
import { num, useTableShape, sqlLiteral, type ShapeResult } from './electric';

/** A Quantity proto leaf: { value, unit }. */
export interface Quantity {
  value: number;
  unit: string;
}

export interface TelemetryLatest {
  asset_id: string;
  platform_variant: string | null;
  callsign: string | null;
  force_id: string | null;
  /** Nested KinematicState proto (position/velocity/attitude). */
  kinematics: Record<string, any> | null;
  /** Nested SustainmentMetrics proto (thermal/power/fluids/...). */
  sustainment: Record<string, any> | null;
  /** Nested Provenance proto (producer_id/source_protocol/...). */
  provenance: Record<string, any>;
  last_sample_at: string | null;
  schema_revision: number;
}

function mapTelemetry(row: Record<string, any>): TelemetryLatest {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? null,
    callsign: row.callsign ?? null,
    force_id: row.force_id ?? null,
    kinematics: row.kinematics ?? null,
    sustainment: row.sustainment ?? null,
    provenance: row.provenance ?? {},
    last_sample_at: row.last_sample_at ?? null,
    schema_revision: num(row.schema_revision),
  };
}

/** Latest telemetry for one asset. Returns at most one row in `data`. */
export function useTelemetryLatest(assetId: string): ShapeResult<TelemetryLatest> {
  return useTableShape('telemetry_latest_state', mapTelemetry, {
    where: `asset_id = ${sqlLiteral(assetId)}`,
  });
}
