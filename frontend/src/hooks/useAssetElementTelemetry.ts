// useAssetElementTelemetry -- per-element sub-component telemetry for one asset.
// Source: asset_element_telemetry, filtered by asset_id.
//
// openddil-logistics-sim publishes one whole-asset envelope per tick;
// the projector upserts it into asset_element_telemetry. The
// elements JSONB column carries the per-element array (one entry per
// {layer, i, j} coordinate the frontend SensorArrayView renders). The
// operational JSONB column mirrors the customer-feed-reported
// OperationalState at that tick -- power_state, health_state,
// actively_transmitting, actively_receiving, degraded.
//
// This hook flattens elements into a Record keyed by element_id so
// SensorArrayView's `liveTelemetry` lookup is O(1) per element render,
// and surfaces the operational block separately so the maintainer
// status banner can read it without re-deriving from per-element bits.
//
// Returns liveTelemetry=undefined when no row exists yet (sim hasn't
// published for this asset, or the asset isn't covered by any
// asset_profile in the sim's config). The view falls back to seeded-
// RNG synthesis in that case.
//
// Multi-profile: the row's profile_name tells consumers which
// asset_profiles[].name in the sim config this asset routed to. MRAD
// today; LTAMDS / Patriot to follow as logistics-sim config
// additions.
import { useMemo, useRef } from 'react';
import { useTableShape, sqlLiteral, type ShapeResult } from './electric';
import type { LiveElementTelemetry } from '../components/SensorArrayView';

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
}

interface AssetElementTelemetryRow {
  asset_id: string;
  platform_variant: string;
  profile_name: string;
  elements: ElementJson[];
  operational: AssetElementOperational;
  observed_at: string | null;
  edge_id: string;
  region_id: string;
  updated_at: string;
}

interface ElementJson {
  element_id: string;
  layer_depth: number;
  layer_name: string;
  health: number;
  temp_c: number;
  load_pct: number;
  tx_active?: boolean;
  rx_active?: boolean;
}

// Electric's Shape API returns JSONB columns as JSON-encoded STRINGS,
// not pre-parsed JS arrays/objects. If we hand `row.elements` through
// raw, the consumer's `for (const e of row.elements)` iterates the
// string CHARACTER BY CHARACTER (each char has no element_id, so the
// inner guard `continue`s every time) and liveTelemetry comes out as
// `{}`. That manifests as every face tile rendering NO_DATA grey
// even though the row is populated in postgres. Parse both JSONB
// columns here so downstream code sees the array/object shapes the
// TypeScript types promise.
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
    elements: _parseJsonbCol<ElementJson[]>(row.elements, []),
    operational: _parseJsonbCol<AssetElementOperational>(row.operational, {}),
    observed_at: row.observed_at ?? null,
    edge_id: row.edge_id ?? '',
    region_id: row.region_id ?? '',
    updated_at: row.updated_at,
  };
}

/** Per-element telemetry for one asset. Returns the flattened lookup
 *  map directly so SensorArrayView's `liveTelemetry` prop wires straight
 *  through, plus the OperationalState mirror for the status banner. */
export function useAssetElementTelemetry(assetId: string | null | undefined): {
  liveTelemetry: LiveElementTelemetry | undefined;
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
      ? { where: `asset_id LIKE ${sqlLiteral(assetId)}` }
      : { where: '1=0' }, // no asset selected -> empty result, hook still safe
  );

  const row = shape.data?.[0];

  // Cache the last successfully-parsed liveTelemetry. ElectricSQL's
  // compacted-topic replication briefly drops shape.data to undefined
  // (or to a row with no elements) WHILE applying the next snapshot,
  // even though the new row has 23k elements and arrives milliseconds
  // later. Without this cache, every tile would flash to NO_DATA grey
  // for one render every 30 seconds when the sim publishes. Falling
  // back to the previous successful parse keeps the UI stable through
  // the blip; the next successful parse replaces the cache.
  const lastGoodRef = useRef<LiveElementTelemetry | undefined>(undefined);

  const liveTelemetry = useMemo<LiveElementTelemetry | undefined>(() => {
    if (!row?.elements?.length) return lastGoodRef.current;
    const out: LiveElementTelemetry = {};
    for (const e of row.elements) {
      if (!e || !e.element_id) continue;
      out[e.element_id] = {
        health: e.health,
        temp: e.temp_c,
        load: e.load_pct,
        // Pass tx_active / rx_active straight through so the
        // SensorArrayView interrogation panel can show "TX off" /
        // "RX off" badges -- the customer sim's actively_tx/rx bits
        // propagate per face element from the logistics-sim publisher.
        txActive: e.tx_active,
        rxActive: e.rx_active,
      };
    }
    lastGoodRef.current = out;
    return out;
  }, [row]);

  return {
    liveTelemetry,
    operational: row?.operational,
    profileName: row?.profile_name,
    observedAt: row?.observed_at ?? null,
    isLoading: shape.isLoading,
  };
}
