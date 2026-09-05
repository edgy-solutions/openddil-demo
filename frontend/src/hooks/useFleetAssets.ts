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
  /** ADR-0029 coalition releasability. The nation that ORIGINATED this row,
   *  and the nations it is releasable to beyond that one.
   *
   *  PRESENTATION ONLY. These are here so the operator can SEE which nation
   *  an asset belongs to; they are not, and must never become, a filter. By
   *  the time a row reaches this hook the gateway has already decided the
   *  subject may see it — ADR-0029 §1 is explicit that frontend filtering is
   *  not access control, and a second filter here would be a second
   *  authorization decision that nobody reviewed.
   *
   *  Null on a deployment that has not enabled releasability. The colour
   *  helpers treat null as "unlabelled" and say so rather than picking a
   *  default nation, because a mislabelled asset on a map is worse than an
   *  obviously unlabelled one. */
  originator_nation: string | null;
  releasable_to: string[];
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
    originator_nation: row.originator_nation ?? null,
    // Electric returns a Postgres text[] as an array; tolerate the
    // brace-string form some drivers produce rather than assuming one.
    releasable_to: Array.isArray(row.releasable_to)
      ? row.releasable_to
      : typeof row.releasable_to === 'string'
        ? row.releasable_to.replace(/^\{|\}$/g, '').split(',').filter(Boolean)
        : [],
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

/** The column that identifies a tier in the read model, and the value that
 *  identifies THIS tier. Together: "my scope".
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  WHY THIS IS A PARAMETER AND NOT TWO FUNCTIONS
 *  ─────────────────────────────────────────────────────────────────────────
 *  Until 2026-09-05 there were two hooks, `useFleetAssetsForEdge` and
 *  `useFleetAssetsForRegion`, which were BYTE-IDENTICAL but for the column
 *  name. Two functions, one shape, differing only in which column encodes
 *  the tier — which is the two-level hierarchy (GD-01) showing through into
 *  the presentation layer.
 *
 *  Collapsing them does not fix GD-01. It concentrates it: the frontend's
 *  entire dependence on "how is a tier addressed?" is now this ONE type and
 *  the one function below, instead of a pattern that would be copied a third
 *  time the moment a third level appeared.
 *
 *  ⚠ AND A THIRD LEVEL CANNOT APPEAR YET. `TierScope.column` can only be a
 *  column that exists, and the read model has exactly `edge_id` and
 *  `region_id` — no `tier_id`, no `tier_path`, no depth. So a fourth tier
 *  still has no left-hand side to be filtered by. That is GD-01's work, not
 *  this hook's, and this comment is here so the next reader does not mistake
 *  a parameterized call site for a solved problem.
 *
 *  When hierarchy-path addressing lands, `column` becomes a path predicate
 *  and every call site above this line is unaffected. That is the whole
 *  point of the collapse. */
export interface TierScope {
  /** A column on `telemetry_latest_state` that identifies a tier.
   *  Constrained to what the schema actually has — widening this union is
   *  GD-01's job and will be a compile error at every affected site, which
   *  is the desired behaviour. */
  column: 'edge_id' | 'region_id';
  /** This tier's identifier. Null/undefined means "not yet resolved" and
   *  yields an UNSCOPED read — see the warning on the hook. */
  value: string | null | undefined;
}

/** Fleet assets within one tier's scope.
 *
 *  ⚠ A NULL `scope` OR A NULL `scope.value` RETURNS THE WHOLE TABLE.
 *  That is inherited behaviour from the two hooks this replaces, and it is
 *  preserved deliberately rather than silently tightened: the maintainer
 *  view's cold start depends on it (the first render happens before the
 *  default edge is resolved from the URL or from observed data).
 *
 *  It is also a sharp edge. An unscoped read at a tier node shows that
 *  tier's whole store, which is correct there, and at the ROOT shows every
 *  tier's — which is correct only if the caller meant it. Post-Slice 1 the
 *  gateway filters by entitlement regardless, so this cannot leak across
 *  nations; it can still show a wider fleet than the caller intended.
 *
 *  Named `useFleetAssetsForTier` and not `...ForScope` because "tier" is the
 *  domain word (ADR-0033) and the scope is how a tier happens to be
 *  addressed today. */
export function useFleetAssetsForTier(
  scope: TierScope | null | undefined,
): ShapeResult<FleetAsset> {
  const where = scope && scope.value
    ? `${scope.column} = ${sqlLiteral(scope.value)}`
    : undefined;
  return useTableShape('telemetry_latest_state', mapFleetAsset, { where });
}

/** Leaf-tier scope. Thin wrapper, kept so the collapse changed no call site.
 *
 *  Distinctive function-name symbol (per ADR-0025 / follow-up #16):
 *  "useFleetAssetsForEdge" is the deployment-proof grep target for §C.2 —
 *  pre-§C.2 bundles do not contain this string; post-build bundles do. That
 *  is why the name survives the collapse rather than being folded away. */
export function useFleetAssetsForEdge(
  edgeId: string | null | undefined,
): ShapeResult<FleetAsset> {
  return useFleetAssetsForTier({ column: 'edge_id', value: edgeId });
}

/** Intermediate-tier scope. Thin wrapper; see above. */
export function useFleetAssetsForRegion(
  regionId: string | null | undefined,
): ShapeResult<FleetAsset> {
  return useFleetAssetsForTier({ column: 'region_id', value: regionId });
}
