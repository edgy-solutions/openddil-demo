// useFleetAssets — every asset the pipeline has seen telemetry for.
// Backs the fleet picker / asset list. Source: telemetry_latest_state.
import { num, sqlLiteral, useTableShape, type ShapeResult } from './electric';
import type { OperationalState } from './useTelemetryLatest';

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
  /** WGS84 position extracted from kinematics.position.wgs84. Null when
   *  the asset has no telemetry row (e.g. strike-only assets like the
   *  customer-overlay launchers). The 3D maps fall back to the assigned FOB's
   *  coordinates in that case — see Fob in src/deployment.ts. */
  position: { lat: number; lon: number } | null;
  /** Phase 5 (ADR-0026): 3-axis operational posture, surfaced for the
   *  Regional 3D map's per-asset schematic rendering — schematics react
   *  to specific values (e.g. POWER_STATE_OFF dims all indicators).
   *  Always present on the returned object; individual axis fields
   *  default to null when the producer didn't emit operational_state. */
  operational_state: OperationalState;
}

function extractPosition(kinematics: any): { lat: number; lon: number } | null {
  // Tolerant of proto-JSON variants: camelCase from the proto encoder OR
  // short keys from compose-era hand-rolled JSON. Mirrors the projector's
  // edge_assignment.extract_wgs84 logic.
  const wgs84 = kinematics?.position?.wgs84;
  if (!wgs84 || typeof wgs84 !== 'object') return null;
  let lat = wgs84.latitude ?? wgs84.lat;
  let lon = wgs84.longitude ?? wgs84.lon;
  // Unwrap {unit, value} objects emitted by sensor-ingest's unit-aware
  // encoder. Mirrors projector's extract_wgs84.
  if (lat && typeof lat === 'object' && 'value' in lat) lat = (lat as any).value;
  if (lon && typeof lon === 'object' && 'value' in lon) lon = (lon as any).value;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
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
    position: extractPosition(row.kinematics),
    operational_state: {
      power_state:           row.power_state ?? null,
      functional_mode:       row.functional_mode ?? null,
      health_state:          row.health_state ?? null,
      actively_receiving:    row.actively_receiving ?? null,
      actively_transmitting: row.actively_transmitting ?? null,
    },
  };
}

export function useFleetAssets(): ShapeResult<FleetAsset> {
  return useTableShape('telemetry_latest_state', mapFleetAsset);
}

// Phase 6c.1: region-scoped variant for the Regional view's pulldown.
// Returns ONLY assets whose telemetry_latest_state.region_id matches
// the given region. Used by RegionalApp's AorAssetList so the picker
// reflects the selected region rather than the global fleet.
//
// Empty regionId returns the unfiltered shape — same as useFleetAssets()
// — so cold-start (pulldown hasn't picked a region yet) doesn't break.
export function useFleetAssetsForRegion(
  regionId: string | null | undefined,
): ShapeResult<FleetAsset> {
  const where = regionId
    ? `region_id = ${sqlLiteral(regionId)}`
    : undefined;
  return useTableShape('telemetry_latest_state', mapFleetAsset, { where });
}

// Phase 6c.2: edge-scoped variant for the Maintainer view's pulldown.
// Returns ONLY assets whose telemetry_latest_state.edge_id matches the
// given edge. Used by MaintainerApp to scope the Header's asset picker
// to the selected edge — the per-asset hooks (useTelemetryLatest /
// useCmState / useLogisticsStatus / useTacticalEvents) ride on the
// picker's narrowing, so they don't need their own edge filter.
//
// Empty edgeId returns the unfiltered shape (same cold-start handling
// as useFleetAssetsForRegion). The maintainer view's default-on-first-
// load logic resolves edgeId from the URL param or from the first
// observed edge alphabetically before this is called with a real value.
//
// Distinctive function-name symbol (per ADR-0025 / follow-up #16):
// "useFleetAssetsForEdge" is the deployment-proof grep target for §C.2
// — pre-§C.2 bundles do not contain this string; post-build bundles do.
export function useFleetAssetsForEdge(
  edgeId: string | null | undefined,
): ShapeResult<FleetAsset> {
  const where = edgeId
    ? `edge_id = ${sqlLiteral(edgeId)}`
    : undefined;
  return useTableShape('telemetry_latest_state', mapFleetAsset, { where });
}
