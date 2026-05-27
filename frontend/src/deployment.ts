// =============================================================================
// Runtime deployment config
// =============================================================================
// Per-deployment configuration the OSS defaults can't carry: customer
// branding (title, logo), FOB topology (lat/lons used by the 3D maps), and
// anything else that varies by who's deploying. Lives in /deployment/
// deployment.json — mounted into the frontend pod by the overlay bundle,
// served by nginx, fetched here at startup.
//
// Renamed from "branding" once it grew past title+logo to also carry the
// FOB list — same lifecycle ("things that change when you deploy for a
// different customer"), same delivery mechanism, more honest name. The
// Deployment type is the union of those concerns; a future split into
// `branding:` and `topology:` sub-blocks is possible if it gets bigger.
// =============================================================================

/** Forward Operating Base — an OpenDDIL edge's geographic anchor.
 *  The HQ and Regional 3D maps use these as markers and as the projection
 *  center; positionless assets (e.g. strike-only launchers) are placed at
 *  their assigned FOB's coordinates rather than dropped. */
export interface Fob {
  /** Edge identifier this FOB anchors (the operator-facing grouping key —
   *  a FOB-coded slug like "fob-alpha", or a legacy "edge-NN" form).
   *  Maintainer view's edge picker shows distinct values of this string;
   *  the picker UI labels it as "FOB" since that's the operator concept.
   *  Distinct from the chart's processing-edge names (redpanda-edge-NN
   *  Kafka clusters) — the data plane scales independently. */
  edge_id: string;
  /** Region the FOB rolls up into (e.g. "region-north", "region-south").
   *  Drives the Regional view's region dropdown. */
  region_id: string;
  /** Geographic anchor (decimal degrees, WGS84). */
  lat: number;
  lon: number;
  /** Human-readable label for the map marker. */
  label?: string;
}

/** Deployment-supplied tactical map underlay configuration. When set, the
 *  HQ 3D view places this map image under the FOBs so the geographic
 *  context is real (rather than the OSS-default decorative texture).
 *
 *  `image` is a path the frontend can GET (typically the overlay path
 *  `/deployment/<name>.png` mounted from the deployment ConfigMap).
 *
 *  `bounds` describes the geographic rectangle the image covers (WGS84
 *  decimal degrees). The component projects these bounds into scene
 *  coordinates via the same projection used for FOBs + assets, so the
 *  texture's geography aligns with where the assets are placed.
 *
 *  Standard north-up map imagery is assumed (image top = north). */
export interface DeploymentMap {
  image: string;
  bounds: {
    lat_min: number;
    lat_max: number;
    lon_min: number;
    lon_max: number;
  };
}

export interface Deployment {
  /** Nav-bar text and document.title. */
  title: string;
  /** Logo shown in the nav bar and used as the favicon. '' = none. */
  logo: string;
  /** Optional FOB list — populated by a deployment overlay. The 3D maps
   *  use this to place edge markers and to home positionless assets.
   *  Empty in the OSS default; the maps render an empty theater. */
  fobs: Fob[];
  /** Optional tactical map underlay. When set, the HQ view shows the
   *  real geography under the FOBs. Absent => decorative fallback
   *  texture (`/map_base.png`) with low opacity. */
  map?: DeploymentMap;
}

const DEFAULT: Deployment = { title: 'OpenDDIL DEMO', logo: '', fobs: [] };

let active: Deployment = DEFAULT;

/** Current deployment config. Meaningful only after loadDeployment() has
 *  resolved. */
export function deployment(): Deployment {
  return active;
}

function isValidFob(x: unknown): x is Fob {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.edge_id === 'string' && f.edge_id.length > 0 &&
    typeof f.region_id === 'string' && f.region_id.length > 0 &&
    typeof f.lat === 'number' && Number.isFinite(f.lat) &&
    typeof f.lon === 'number' && Number.isFinite(f.lon)
  );
}

function isValidDeploymentMap(x: unknown): x is DeploymentMap {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  if (typeof m.image !== 'string' || m.image.length === 0) return false;
  const b = m.bounds as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return false;
  return (
    typeof b.lat_min === 'number' && Number.isFinite(b.lat_min) &&
    typeof b.lat_max === 'number' && Number.isFinite(b.lat_max) &&
    typeof b.lon_min === 'number' && Number.isFinite(b.lon_min) &&
    typeof b.lon_max === 'number' && Number.isFinite(b.lon_max) &&
    b.lat_max > b.lat_min && b.lon_max > b.lon_min
  );
}

/**
 * Fetch optional overlay deployment config, then apply document.title and
 * the favicon. Call once before the first render. Any failure (no overlay,
 * 404, bad JSON) leaves the OpenDDIL defaults in place — it never throws.
 */
export async function loadDeployment(): Promise<void> {
  try {
    const res = await fetch('/deployment/deployment.json', { cache: 'no-store' });
    if (res.ok) {
      const j = (await res.json()) as Partial<Deployment>;
      active = {
        title: j.title?.trim() || DEFAULT.title,
        logo: j.logo?.trim() || DEFAULT.logo,
        fobs: Array.isArray(j.fobs) ? j.fobs.filter(isValidFob) : DEFAULT.fobs,
        map: isValidDeploymentMap(j.map) ? j.map : undefined,
      };
    }
  } catch {
    // No overlay reachable — keep the OpenDDIL defaults.
  }
  document.title = active.title;
  if (active.logo) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = active.logo;
  }
}
