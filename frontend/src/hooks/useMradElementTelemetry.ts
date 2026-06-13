// useMradElementTelemetry -- per-element radar telemetry for one MRAD asset.
// Source: mrad_element_telemetry, filtered by asset_id.
//
// openddil-mrad-sim publishes one whole-asset envelope per tick, which the
// projector upserts into mrad_element_telemetry.elements as a JSONB array.
// This hook fetches the row + flattens .elements into a Record keyed by
// element_id so SensorArrayView's `liveTelemetry` lookup is O(1) per
// element render.
//
// Returns undefined when no row exists yet (sim hasn't published for this
// asset, or the asset isn't MRAD-class). The view then falls back to its
// seeded-RNG synthesis so the demo still looks alive without the sim
// running.
import { useMemo } from 'react';
import { useTableShape, sqlLiteral, type ShapeResult } from './electric';
import type { LiveElementTelemetry } from '../components/SensorArrayView';

interface MradElementTelemetryRow {
  asset_id: string;
  elements: ElementJson[];
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
}

function mapRow(row: Record<string, any>): MradElementTelemetryRow {
  return {
    asset_id: row.asset_id,
    elements: row.elements ?? [],
    observed_at: row.observed_at ?? null,
    edge_id: row.edge_id ?? '',
    region_id: row.region_id ?? '',
    updated_at: row.updated_at,
  };
}

/** Per-element telemetry for one MRAD asset. Returns the flattened lookup
 *  map directly so SensorArrayView's `liveTelemetry` prop wires straight
 *  through. Returns undefined when no row exists. */
export function useMradElementTelemetry(assetId: string | null | undefined): {
  liveTelemetry: LiveElementTelemetry | undefined;
  observedAt: string | null;
  isLoading: boolean;
} {
  const shape: ShapeResult<MradElementTelemetryRow> = useTableShape(
    'mrad_element_telemetry',
    mapRow,
    assetId
      ? { where: `asset_id = ${sqlLiteral(assetId)}` }
      : { where: '1=0' }, // no asset selected -> empty result, hook still safe to call
  );

  const liveTelemetry = useMemo<LiveElementTelemetry | undefined>(() => {
    const row = shape.data?.[0];
    if (!row?.elements?.length) return undefined;
    const out: LiveElementTelemetry = {};
    for (const e of row.elements) {
      if (!e || !e.element_id) continue;
      out[e.element_id] = {
        health: e.health,
        temp: e.temp_c,
        load: e.load_pct,
      };
    }
    return out;
  }, [shape.data]);

  return {
    liveTelemetry,
    observedAt: shape.data?.[0]?.observed_at ?? null,
    isLoading: shape.isLoading,
  };
}
