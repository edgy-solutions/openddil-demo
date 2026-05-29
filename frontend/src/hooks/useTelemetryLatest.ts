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

/** Phase 5: operational_state 3-axis posture (ADR-0026). Mirrors the
 *  EntityTelemetryEvent.operational_state proto fields, with each axis as
 *  its own column on telemetry_latest_state. Producers that don't fill
 *  the field (legacy DIS, capability-only assets) leave all five fields
 *  null; the GROUND DIAGNOSTICS panel renders "—" per missing axis. */
export interface OperationalState {
  /** POWER_STATE_OFF / STANDBY / OPERATE / MAINTENANCE / SHUTTING_DOWN /
   *  POWER_STATE_UNSPECIFIED. Stored as the proto's enum-name string so
   *  the SPA's pill-color mapping can switch on exact values. */
  power_state: string | null;
  /** FUNCTIONAL_MODE_IDLE / ACTIVE / RECEIVE_ONLY / TRANSMIT_ONLY /
   *  FUNCTIONAL_MODE_UNSPECIFIED. */
  functional_mode: string | null;
  /** HEALTH_STATE_OK / DEGRADED / FAULT / FAILED /
   *  HEALTH_STATE_UNSPECIFIED. */
  health_state: string | null;
  /** Discrete RX cue — independent of functional_mode; true if the
   *  entity is currently consuming on its primary receive path. */
  actively_receiving: boolean | null;
  /** Discrete TX cue — independent of functional_mode; true if the
   *  entity is currently emitting on its primary transmit path. */
  actively_transmitting: boolean | null;
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
  /** Phase 5: OperationalState 3-axis breakout. Always present on the
   *  returned object — fields default to null when the producer didn't
   *  fill operational_state. */
  operational_state: OperationalState;
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
    operational_state: {
      power_state:           row.power_state ?? null,
      functional_mode:       row.functional_mode ?? null,
      health_state:          row.health_state ?? null,
      actively_receiving:    row.actively_receiving ?? null,
      actively_transmitting: row.actively_transmitting ?? null,
    },
  };
}

/** Latest telemetry for one asset. Returns at most one row in `data`. */
export function useTelemetryLatest(assetId: string): ShapeResult<TelemetryLatest> {
  return useTableShape('telemetry_latest_state', mapTelemetry, {
    where: `asset_id = ${sqlLiteral(assetId)}`,
  });
}
