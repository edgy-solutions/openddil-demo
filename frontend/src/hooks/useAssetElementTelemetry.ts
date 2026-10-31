// useAssetElementTelemetry -- the per-asset row of asset_element_telemetry.
// It carries the OperationalState mirror (power_state, health_state, tx/rx,
// degraded, condition, core_temp_c, uptime_hours), the profile name and the
// observation time. Per-element values are NOT read here: the drilldown
// subscribes to asset_element_state per open node (useElementLevel).
//
// The row is read for its operational, profile and time columns only.
// Multi-profile: profile_name tells consumers which asset_profiles[].name in
// the sim config this asset routed to.
import { useTableShape, sqlLiteral, type ShapeResult } from './electric';
import type { Condition } from '../lib/condition';

export interface AssetElementOperational {
  power_state?: string;
  health_state?: string;
  actively_transmitting?: boolean;
  actively_receiving?: boolean;
  degraded?: boolean;
  // Asset-level rollups synthesized by logistics-sim because the
  // customer-overlay proprietary feed doesn't carry sustainment data
  // (no temps, no hour meters). The maintainer 3D view's CORE TEMP /
  // UPTIME readouts pick these up; null/undefined falls back to the
  // hardcoded literals in SensorArrayView.
  core_temp_c?: number;
  uptime_hours?: number;
  // Resolved DIS-state condition with the sources that moved it. Absent
  // when no source claims (absence is not health).
  condition?: Condition;
}

interface AssetElementTelemetryRow {
  asset_id: string;
  platform_variant: string;
  profile_name: string;
  operational: AssetElementOperational;
  observed_at: string | null;
  edge_id: string;
  region_id: string;
  updated_at: string;
}

// Electric's Shape API returns JSONB columns as JSON-encoded strings; parse
// the operational column so consumers see the object the types promise.
function _parseJsonbCol<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function mapRow(row: Record<string, any>): AssetElementTelemetryRow {
  return {
    asset_id: row.asset_id,
    platform_variant: row.platform_variant ?? '',
    profile_name: row.profile_name ?? '',
    operational: _parseJsonbCol<AssetElementOperational>(row.operational, {}),
    observed_at: row.observed_at ?? null,
    edge_id: row.edge_id ?? '',
    region_id: row.region_id ?? '',
    updated_at: row.updated_at,
  };
}

/** The per-asset row: OperationalState mirror, profile name, observation time. */
export function useAssetElementTelemetry(assetId: string | null | undefined): {
  operational: AssetElementOperational | undefined;
  profileName: string | undefined;
  observedAt: string | null;
  isLoading: boolean;
} {
  const shape: ShapeResult<AssetElementTelemetryRow> = useTableShape(
    'asset_element_telemetry',
    mapRow,
    assetId
      // LIKE-without-wildcard is SQL-equivalent to =, but works around an
      // Electric Shape API bug where `column = literal` returns empty for
      // rows whose serialized JSON exceeds ~1MB. asset_element_telemetry
      // rows are ~5MB on the wire (the full 23k-element tree from
      // logistics-sim), so the = path silently returns snapshot-end with
      // no rows. Verified by binary search: small row with same asset_id
      // filtered by = → returns data; large row → empty; same large row
      // filtered by LIKE → returns data.
      // TODO: report to ElectricSQL upstream; remove this workaround when
      // patched. Other hooks (useCmState, useCapabilityState, etc.) use
      // the same pattern but on smaller rows so haven't tripped this yet.
      // fromNow: 5MB rows rewritten every ~20s; start at the head. The current
      // row arrives with the next rewrite, about 20 s.
      ? { where: `asset_id LIKE ${sqlLiteral(assetId)}`, fromNow: true }
      : { where: '1=0', fromNow: true }, // no asset selected -> empty result, hook still safe
  );

  const row = shape.data?.[0];

  return {
    operational: row?.operational,
    profileName: row?.profile_name,
    observedAt: row?.observed_at ?? null,
    isLoading: shape.isLoading,
  };
}
