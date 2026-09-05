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
import type { TierScope } from './hooks/useFleetAssets';

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

/** Asset-liveness thresholds — how long can an asset stop talking
 *  before its tier degrades. All seconds. Drives the
 *  ACTIVE/DEGRADED/STALE/COMM_LOST/LOST classification in lib/assetTier
 *  which the 3D scene + pulldown read to dim, badge, or hide.
 *
 *  Going stale is a pure time threshold (a 1s blip can't fire a 30s
 *  cutoff). Going back to ACTIVE requires `recovery_samples_n` distinct
 *  recent samples within `recovery_window_s` to absorb single-sample
 *  blips that would otherwise yank an asset out of STALE/LOST and back
 *  to ACTIVE on every momentary reconnect.
 *
 *  Defaults are sized for ~1Hz sim cadence; tune per deployment. */
export interface LivenessThresholds {
  /** Seconds since last sample before tier downgrades to STALE
   *  (or COMM_LOST when the asset's edge link is also severed). */
  stale_after_s: number;
  /** Seconds since last sample before tier downgrades to LOST (the
   *  3D-scene-hidden tier; assets remain queryable for forensics). */
  lost_after_s: number;
  /** How many distinct recent samples are needed to recover back to
   *  ACTIVE from STALE/COMM_LOST/LOST. 1 = immediate; >1 = wait for
   *  consecutive heartbeats. */
  recovery_samples_n: number;
  /** Sliding window in seconds within which `recovery_samples_n`
   *  samples must fall to count as a recovery. */
  recovery_window_s: number;
}

export const DEFAULT_LIVENESS: LivenessThresholds = {
  stale_after_s:      30,
  lost_after_s:       300,
  recovery_samples_n: 3,
  recovery_window_s:  10,
};

/** Which tier this instance IS — ADR-0033's amendment made operational.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  THE WHOLE MECHANISM IS THAT THIS ARRIVES AT RUNTIME
 *  ─────────────────────────────────────────────────────────────────────────
 *  One image, zero tier knowledge at build time, tier identity supplied
 *  entirely at deploy time. That is not a preference — it is forced. The
 *  chart previously set a per-tier `ELECTRIC_URL` env var against a value
 *  Vite had baked into the bundle at build, so the env var was read by
 *  nothing and every tier's UI silently read the ROOT's store (UD-9). A
 *  container env var cannot reach a compiled-in constant; a fetched config
 *  file can.
 *
 *  So tier identity rides the channel that already worked: this file,
 *  fetched at startup, served from a per-tier ConfigMap.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  SHAPE, NOT NAME
 *  ─────────────────────────────────────────────────────────────────────────
 *  Nothing downstream branches on `id`. Panels are selected by whether this
 *  tier HAS CHILDREN (does it roll anything up?) and whether it HAS A PARENT
 *  (can its uplink be severed?). That is what makes "which of the three
 *  views does a fourth tier get?" a well-formed question with an obvious
 *  answer instead of an unanswerable one — a fourth tier has a shape, and
 *  the shape selects the panels.
 *
 *  `label` is for humans and is read by the header only.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  WHAT THIS DOES NOT SOLVE
 *  ─────────────────────────────────────────────────────────────────────────
 *  `scope` can only name a column the read model has — `edge_id` or
 *  `region_id`. A tier at depth 3 has nothing to be filtered by, so a fourth
 *  tier still cannot be scoped (GD-01). This type makes the dependency
 *  explicit and confines it; it does not remove it. */
export interface TierConfig {
  /** This tier's identifier, e.g. "edge-northpoint", "region-east", "hq".
   *  DISPLAY AND CORRELATION ONLY — no panel selection reads it. */
  id: string;
  /** Human label for the header. Falls back to `id`. */
  label?: string;
  /** How this tier is addressed in the read model, or null for a tier whose
   *  store holds only its own subtree already (the root of a deployment
   *  whose store is not shared, or any tier node with its own database).
   *
   *  Null means "read the store unscoped", which is CORRECT at a tier node
   *  — its store contains its subtree and nothing else — and is why the
   *  root and a tier node can share one code path. */
  scope: TierScope | null;
  /** Does this tier roll anything up? Selects the aggregate panels. */
  has_children: boolean;
  /** This tier's parent id, or null at the root. Presence selects the
   *  uplink / severance panel: a root has no uplink to lose. */
  parent?: string | null;
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
  /** Asset-liveness thresholds (per-deployment override). Defaults to
   *  DEFAULT_LIVENESS when absent or any individual field is missing /
   *  non-finite. */
  liveness: LivenessThresholds;
  /** Which tier this instance is. ABSENT means "no tier was configured",
   *  which is a real and supported state: the demo shell renders its tabs
   *  and says so. Present means this deployment is a tier node and the UI
   *  is that tier's instance.
   *
   *  Deliberately optional rather than defaulted. A default here would give
   *  every unconfigured deployment a confident, wrong tier identity — and
   *  "the UI believes it is a tier it is not" is precisely the class of
   *  defect (UD-9) this field exists to close. */
  tier?: TierConfig;
}

const DEFAULT: Deployment = {
  title: 'OpenDDIL DEMO',
  logo: '',
  fobs: [],
  liveness: DEFAULT_LIVENESS,
};

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

function mergeLiveness(x: unknown): LivenessThresholds {
  // Per-field fallback: each missing / non-positive / non-finite knob falls
  // back to DEFAULT_LIVENESS independently so a partial override doesn't
  // accidentally zero out the others.
  const d = DEFAULT_LIVENESS;
  if (!x || typeof x !== 'object') return d;
  const l = x as Record<string, unknown>;
  const pickPos = (key: keyof LivenessThresholds): number => {
    const v = l[key];
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : d[key];
  };
  return {
    stale_after_s:      pickPos('stale_after_s'),
    lost_after_s:       pickPos('lost_after_s'),
    recovery_samples_n: Math.max(1, Math.floor(pickPos('recovery_samples_n'))),
    recovery_window_s:  pickPos('recovery_window_s'),
  };
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

/** A tier config is accepted only if it is COMPLETE and INTERNALLY
 *  CONSISTENT. A partial one is rejected outright rather than merged with
 *  defaults.
 *
 *  That asymmetry with `liveness` (which merges field by field) is
 *  deliberate. A half-applied liveness threshold gives slightly wrong
 *  timing. A half-applied TIER IDENTITY gives a UI that confidently
 *  believes it is a tier it is not — which is UD-9's failure mode arriving
 *  through the door built to prevent it. There is no safe default for "who
 *  am I", so absence is the only alternative to a complete answer.
 *
 *  Rejection is LOUD: a console error, because a tier node whose config was
 *  silently discarded renders the demo shell and looks merely
 *  misconfigured rather than broken. */
/** EXPORTED FOR TESTS, deliberately. Reaching it through
 *  `loadDeployment` would test a fetch stub, a JSON parse and a DOM
 *  write alongside the one thing under examination — and it forced a
 *  jsdom dependency for a function that touches no DOM. A validator is
 *  a decision; decisions get direct tests. */
export function parseTier(raw: unknown): TierConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const t = raw as Partial<TierConfig>;
  const bad = (why: string): undefined => {
    // eslint-disable-next-line no-console
    console.error(
      `[deployment] tier config rejected (${why}). This instance will render ` +
      'the demo shell, NOT a tier instance. A partial tier identity is worse ' +
      'than none: see UD-9.',
      raw,
    );
    return undefined;
  };
  if (typeof t.id !== 'string' || !t.id.trim()) return bad('missing id');
  if (typeof t.has_children !== 'boolean') return bad('has_children must be a boolean');
  // `scope` must be explicitly null or a valid pair. Undefined is NOT
  // accepted as "null": omitting it reads as an oversight, and an oversight
  // that produces an unscoped read at a tier with children would show the
  // whole subtree under a leaf's label.
  if (t.scope !== null) {
    const sc = t.scope as TierScope | undefined;
    if (!sc || (sc.column !== 'edge_id' && sc.column !== 'region_id')) {
      return bad('scope must be null or {column: edge_id|region_id, value}');
    }
    if (typeof sc.value !== 'string' || !sc.value.trim()) {
      return bad('scope.value must be a non-empty string');
    }
  }
  return {
    id: t.id.trim(),
    label: typeof t.label === 'string' && t.label.trim() ? t.label.trim() : undefined,
    scope: t.scope === null ? null : (t.scope as TierScope),
    has_children: t.has_children,
    parent: typeof t.parent === 'string' && t.parent.trim() ? t.parent.trim() : null,
  };
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
        liveness: mergeLiveness(j.liveness),
        tier: parseTier((j as { tier?: unknown }).tier),
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
