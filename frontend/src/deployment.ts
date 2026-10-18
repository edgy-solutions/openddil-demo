// =============================================================================
// Runtime deployment config
// =============================================================================
// Per-deployment configuration the OSS defaults can't carry: customer
// branding (title, logo), FOB topology (lat/lons used by the 3D maps), and
// anything else that varies by who's deploying. Two sources, both served
// by nginx and fetched here at startup: /deployment/deployment.json from
// the chart, and an optional /deployment-overlay/deployment.json mounted
// by an overlay bundle. The overlay wins per top-level key. An overlay
// that ships a logo or map image references it as /deployment-overlay/<name>.
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
 *  `image` is a path the frontend can GET (typically a path such as
 *  `/deployment/<name>.png` or `/deployment-overlay/<name>.png`, mounted
 *  from a deployment ConfigMap).
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
  /** This tier's identifier, e.g. "edge-north", "region-east", "hq".
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

/** One configured column of a `ReleasedRecordsPane` — see
 *  components/releasability/ReleasedRecordsPane.tsx. `pointer` is a JSON
 *  pointer (RFC 6901) into a record's `body`. */
export interface ReleasedRecordsColumnConfig {
  header: string;
  pointer: string;
}

/** One configured instance of `ReleasedRecordsPane` — a destination, an
 *  optional kind, and the columns to render for it. Unconfigured means
 *  none: the field is absent in the OSS default and in any deployment that
 *  does not supply it, and HqApp renders nothing in that case rather than
 *  a fixed, hard-coded pane (see ReleasedRecordsPane.tsx's own header on
 *  why a destination is configuration, not code). */
/** The hub's egress admission pane: present only where the hub serves the
 *  pane (through its PEP). `destination` is the destination the pane opens
 *  on; the operator can type another. */
export interface EgressPaneConfig {
  destination: string;
}

/** The manual-question panel's own config. `stub` says whether the
 *  upstream manual question service answering this deployment is a
 *  stand-in rather than the real thing -- defaults to true (unconfigured
 *  == assume a stub) so a deployment that says nothing about it still
 *  gets the DemoMockBanner rather than silently looking production-real.
 *  Only a deployment that explicitly sets `stub: false` turns the banner
 *  off. */
export interface ManualQaConfig {
  stub?: boolean;
}

export interface ReleasedRecordsPaneConfig {
  title: string;
  destination: string;
  kind?: string;
  columns: ReleasedRecordsColumnConfig[];
  /** Optional: where a record names the illustrated-parts figure it cites
   *  and the object within it, named by its applicationStructureIdent
   *  (the object's `id` in the figure). Both are JSON pointers (RFC 6901, same
   *  convention as `columns`) into `record.body`; when set, each row whose
   *  icn resolves to a safe figure number gets a Figure toggle. Absent when
   *  not configured, or when either pointer is malformed -- a bad `figure`
   *  never drops the pane itself. A config still using the old
   *  pointer name is dropped with a console warning. */
  figure?: { icnPointer: string; applicationStructureIdentPointer: string };
}

/** How an edge's rows reach HQ's postgres — declared by the deployment,
 *  never inferred by the frontend (see openddil-helm's
 *  openddil.validateEdgeAttachment, which checks the declaration against
 *  the chart's own tierNode topology at render time).
 *
 *  `tier`: the edge projects into its own tier store; survives an uplink
 *  cut; goes stale at HQ during one.
 *  `hq`: the edge writes straight to HQ; has no edge store; stays fresh at
 *  HQ during an uplink cut because HQ is where it lives. */
export type EdgeAttachment = 'tier' | 'hq';

/** One entry of `deployment.json`'s `edges` list — see `parseEdgeAttachments`. */
export interface EdgeAttachmentEntry {
  id: string;
  attachment: EdgeAttachment;
}

/** One entry of `deployment.json`'s `childLinks` list — see `parseChildLinks`. */
export interface ChildLinkEntry {
  id: string;
  /** True when the child rolls up its own subtree (a hub); false for a leaf
   *  attached directly to this node. */
  hasChildren: boolean;
}

/** Optional configured HQ location (`deployment.json`'s `hq`). */
export interface HqLocation {
  lat: number;
  lon: number;
  label?: string;
}

/** One entry of `deployment.json`'s `tiers` list (the chart's whole tier tree)
 *  -- see `parseTiers`. `parent` is as the chart gave it: a tier id, or a
 *  root/hq/empty value meaning "directly under HQ". */
export interface TierEntry {
  id: string;
  parent: string | null;
  hasChildren: boolean;
}

export interface CortexConfig {
  /** http(s) origin of cortex, trailing slash stripped. */
  baseUrl: string;
  /** Optional cortex-recognised broker marker appended to the links
   *  (`idp=<value>`). Absent means no marker. */
  idp?: string;
}

export interface Deployment {
  /** Nav-bar text and document.title. */
  title: string;
  /** Logo shown in the nav bar and used as the favicon. '' = none. */
  logo: string;
  /** Configured `ReleasedRecordsPane` instances (ADR-0046 s5). Parsed
   *  defensively by `parseReleasedRecordsPanes`: an entry with a missing or
   *  non-string required field is dropped rather than rendered half-
   *  configured. Absent or malformed in the overlay => []. */
  releasedRecordsPanes: ReleasedRecordsPaneConfig[];
  /** The egress admission pane. ABSENT means the pane is not rendered: a
   *  hub with no egress answers /egress with a 404, and a pane that can only
   *  say "could not load" is noise. Parsed by `parseEgressPane`. */
  egressPane?: EgressPaneConfig;
  /** The manual-question panel's config. ABSENT is a normal, supported
   *  state (treated the same as `{}`/`{stub: true}` by every reader of
   *  this field) -- it is not the "is this feature on at this tier"
   *  switch (that's the gateway route itself, OPENDDIL_MANUAL_QA_URL /
   *  the panel's own 404 handling); it only ever affects whether the
   *  DemoMockBanner shows. */
  manualQa?: ManualQaConfig;
  /** The cortex deployment this UI links to. ABSENT means no cortex UI
   *  anywhere (the OSS and work default). Parsed by `parseCortex`. */
  cortex?: CortexConfig;
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
  /** Declared edge attachments (ADR edge-attachment labeling) — which edges
   *  are HQ-attached and which project into their own tier. ABSENT means
   *  no edge declared one; `edgeAttachment(id)` returns undefined for
   *  every edge in that case, same as for an edge that is present but did
   *  not declare one. Parsed by `parseEdgeAttachments`. DECLARED ONLY —
   *  never inferred here; the chart is the only source of this list. */
  edges?: EdgeAttachmentEntry[];
  /** Declared shape of each direct child of this node (one entry per child
   *  link). ABSENT means nothing was declared (no children, or an older
   *  chart); `childLinkShape(id)` returns undefined for every child in that
   *  case. Parsed by `parseChildLinks`. DECLARED ONLY — never inferred from
   *  an id; the chart is the only source of this list. */
  childLinks?: ChildLinkEntry[];
  /** The chart's tier tree, when rendered. Absent => the HQ theater draws
   *  one link per FOB straight to HQ. */
  tiers?: TierEntry[];
  /** Where HQ sits on the HQ theater, when the chart declares it. ABSENT
   *  means HQ is drawn at the centre of the FOBs. Parsed by `parseHq`. */
  hq?: HqLocation;
  /** Declared inputs to the move panel: effector declared load, movement
   *  standards and movement units. ABSENT on an older chart that carries
   *  neither key; present (possibly with empty maps) otherwise. Parsed by
   *  `parseMoveInputs`. DECLARED ONLY. */
  moveInputs?: MoveInputs;
}

/** A declared quantity with its unit, e.g. {value: 500, unit: 'L'}. */
export interface UnitQuantity {
  value: number;
  unit: string;
}

/** Declared movement standard for one platform variant. Every field optional:
 *  an undeclared one is unknown, never defaulted. */
export interface MoveStandard {
  marchOrderS?: number;
  emplaceS?: number;
  fuelTank?: UnitQuantity;
  fuelBurnPerKm?: UnitQuantity;
}

/** A declared movement unit: the assets that move together. */
export interface MoveUnit {
  id: string;
  label: string;
  members: string[];
  plannedMoveKm?: number;
}

/** Declared effector load: munition key -> count, per asset id and per
 *  platform variant. */
export interface DeclaredLoadConfig {
  asset: Record<string, Record<string, number>>;
  variant: Record<string, Record<string, number>>;
}

export interface MoveInputs {
  declaredLoad: DeclaredLoadConfig;
  standards: Record<string, MoveStandard>;
  units: MoveUnit[];
}

/** THE TIER A DEPLOYMENT GETS WHEN IT DECLARES NONE.
 *
 *  A deployment that says nothing about tiers is a single node, and a
 *  single node is a root: it has no parent, and it rolls up whatever it
 *  holds. That is ADR-0033's endpoint stated as a default rather than as
 *  an aspiration — "the root tier is just the node with no parent".
 *
 *  This replaces falling through to the demo shell, which is how a
 *  COMPOSED multi-tier view came to occupy the root host's endpoint. The
 *  shell is still reachable at /demo, and is a viewer rather than a node.
 *
 *  ⚠ ABSENT IS NOT REJECTED. A `tier` block that is present and malformed
 *  must NEVER land here — a partial tier identity rendering as a confident
 *  root is UD-9 with a different label. `loadDeployment` only substitutes
 *  this when the key is absent altogether. */
export const IMPLICIT_ROOT: TierConfig = {
  id: 'root',
  label: 'hq',
  scope: null,
  has_children: true,
  parent: null,
};

const DEFAULT: Deployment = {
  title: 'OpenDDIL',
  logo: '',
  fobs: [],
  liveness: DEFAULT_LIVENESS,
  tier: IMPLICIT_ROOT,
  releasedRecordsPanes: [],
};

let active: Deployment = DEFAULT;

/** Current deployment config. Meaningful only after loadDeployment() has
 *  resolved. */
/** TEST SEAM. Sets the tier this deployment serves, so `isThisNode` can be
 *  exercised without a fetch, a DOM or a jsdom dependency.
 *
 *  Deliberately narrow: it sets the ONE field the identity rule reads, so a
 *  test cannot accidentally assert against a whole synthetic deployment that
 *  drifts from the real default. `undefined` restores the module default. */
export function __setDeploymentForTest(tier: TierConfig | null | undefined): void {
  active = { ...active, tier: tier === undefined ? IMPLICIT_ROOT : (tier ?? undefined) };
}

export function deployment(): Deployment {
  return active;
}

/** This tier's parent id from its own configuration, or null when it has
 *  none. Independent of link control: a tier knows its parent whether or not
 *  the link toggles are available. */
export function parentTierName(): string | null {
  return active.tier?.parent ?? null;
}

/** Is `id` the root tier? The root is the tier with no parent: this tier's
 *  own id when it has no parent, otherwise the implicit root's id. */
export function isRootTier(id: string): boolean {
  const t = active.tier;
  if (t && !t.parent && t.id === id) return true;
  return id === IMPLICIT_ROOT.id;
}

/** How a parent is shown: 'HQ' for the root, otherwise the id as configured. */
export function parentDisplay(id: string): string {
  return isRootTier(id) ? 'HQ' : id;
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
      'a CONFIGURATION ERROR and no fleet data at all — not a tier instance, ' +
      'and deliberately not an implicit root either. A partial tier identity ' +
      'is worse than none: see UD-9.',
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

/** Parses `deployment.json`'s `releasedRecordsPanes`, defensively.
 *
 *  An entry is kept only when `title` and `destination` are non-empty
 *  strings, `kind` (if present) is a string, and `columns` is an array of
 *  `{header, pointer}` pairs where both fields are strings. Anything else
 *  about the entry — wrong types, missing fields, a malformed column — drops
 *  the WHOLE entry rather than rendering a half-configured pane: a pane
 *  bound to a destination string that silently defaulted to '' would ask
 *  the gate a question nobody configured, not render nothing (the same
 *  reasoning `parseTier` applies to a partial tier identity).
 *
 *  Not an array at all, or absent => []. EXPORTED FOR TESTS, same reasoning
 *  as `parseTier`: a parser is a decision, and decisions get direct tests. */
/** `{destination: <non-empty string>}` => that config; anything else =>
 *  undefined, so a malformed entry hides the pane rather than opening it on
 *  an empty destination. EXPORTED FOR TESTS. */
export function parseEgressPane(raw: unknown): EgressPaneConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const d = (raw as Record<string, unknown>).destination;
  return typeof d === 'string' && d.trim().length > 0 ? { destination: d.trim() } : undefined;
}

/** `{stub?: boolean}` -> that config, dropping any non-boolean `stub`
 *  rather than coercing it (so a malformed overlay value falls back to
 *  the default-true reading, same as an absent field, instead of
 *  silently becoming `undefined && false`-ish truthy/falsy guesswork).
 *  Anything that isn't an object at all -> undefined, which every reader
 *  of `manualQa` treats identically to `{}`. EXPORTED FOR TESTS, same
 *  reasoning as `parseEgressPane`. */
/** Parses `deployment.json`'s `edges` list, defensively, like
 *  `parseEgressPane`. Not an array at all (key absent or wrong type) =>
 *  undefined, same reading `edgeAttachment` gives for "nothing declared".
 *
 *  Within an array, each entry is checked independently: a malformed one
 *  (missing/non-string `id`, or an `attachment` that isn't exactly `tier`
 *  or `hq`) is DROPPED, with a console.warn naming why -- never coerced to
 *  a guessed value, same reasoning as `parseTier`'s "no safe default for a
 *  declaration" (an unknown attachment value is closer to a typo than to
 *  an omission, and silently guessing which of `tier`/`hq` it meant would
 *  risk mislabeling the HQ screens instead of leaving the edge unlabeled).
 *  EXPORTED FOR TESTS, same reasoning as `parseEgressPane`. */
export function parseEdgeAttachments(raw: unknown): EdgeAttachmentEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EdgeAttachmentEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      console.warn('[deployment] edges entry dropped (not an object):', entry);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.trim()) {
      console.warn('[deployment] edges entry dropped (missing/invalid id):', entry);
      continue;
    }
    if (e.attachment !== 'tier' && e.attachment !== 'hq') {
      console.warn(
        `[deployment] edges entry for "${e.id}" dropped (attachment must be ` +
        `"tier" or "hq"):`,
        entry,
      );
      continue;
    }
    out.push({ id: e.id.trim(), attachment: e.attachment });
  }
  return out;
}

/** Looks up a single edge's declared attachment. Undefined when nothing
 *  was declared for this deployment at all, or nothing was declared for
 *  this particular edge -- the two are indistinguishable on purpose,
 *  because both mean "render this edge exactly as a tier edge." */
export function edgeAttachment(edgeId: string): EdgeAttachment | undefined {
  return active.edges?.find((e) => e.id === edgeId)?.attachment;
}

/** Parses `deployment.json`'s `childLinks` list, defensively, like
 *  `parseEdgeAttachments`. Not an array => undefined. Within an array, an
 *  entry that is not an object, has a missing/blank `id`, or a
 *  `hasChildren` that is not exactly a boolean is DROPPED with a
 *  console.warn -- never coerced (a guessed shape would put a link control
 *  on the wrong line). EXPORTED FOR TESTS. */
export function parseChildLinks(raw: unknown): ChildLinkEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChildLinkEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      console.warn('[deployment] childLinks entry dropped (not an object):', entry);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.trim()) {
      console.warn('[deployment] childLinks entry dropped (missing/invalid id):', entry);
      continue;
    }
    if (typeof e.hasChildren !== 'boolean') {
      console.warn(
        `[deployment] childLinks entry for "${e.id}" dropped (hasChildren must be a boolean):`,
        entry,
      );
      continue;
    }
    out.push({ id: e.id.trim(), hasChildren: e.hasChildren });
  }
  return out;
}

/** Parses `deployment.json`'s `hq`, defensively: lat and lon must be finite
 *  numbers in range, else the whole value is dropped (HQ then draws at the
 *  FOB centre). An empty or non-string label is dropped alone. */
export function parseHq(raw: unknown): HqLocation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[deployment] hq dropped (not an object):', raw);
    return undefined;
  }
  const h = raw as Record<string, unknown>;
  if (typeof h.lat !== 'number' || !Number.isFinite(h.lat) || h.lat < -90 || h.lat > 90 ||
      typeof h.lon !== 'number' || !Number.isFinite(h.lon) || h.lon < -180 || h.lon > 180) {
    console.warn('[deployment] hq dropped (lat/lon must be finite numbers, lat in [-90,90], lon in [-180,180]):', raw);
    return undefined;
  }
  const out: HqLocation = { lat: h.lat, lon: h.lon };
  if (typeof h.label === 'string' && h.label.length > 0) out.label = h.label;
  return out;
}

/** Parses `deployment.json`'s `tiers` list, defensively, like
 *  `parseChildLinks`: not an array => undefined; an entry that is not an
 *  object, has a blank `id`, a `parent` that is neither string nor null, or a
 *  non-boolean `hasChildren` is DROPPED with a console.warn. An empty result
 *  is undefined (no tree). EXPORTED FOR TESTS. */
export function parseTiers(raw: unknown): TierEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TierEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      console.warn('[deployment] tiers entry dropped (not an object):', entry);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.trim()) {
      console.warn('[deployment] tiers entry dropped (missing/invalid id):', entry);
      continue;
    }
    if (e.parent !== null && e.parent !== undefined && typeof e.parent !== 'string') {
      console.warn(`[deployment] tiers entry for "${e.id}" dropped (parent must be a string or null):`, entry);
      continue;
    }
    if (typeof e.hasChildren !== 'boolean') {
      console.warn(`[deployment] tiers entry for "${e.id}" dropped (hasChildren must be a boolean):`, entry);
      continue;
    }
    out.push({ id: e.id.trim(), parent: typeof e.parent === 'string' ? e.parent.trim() : null, hasChildren: e.hasChildren });
  }
  return out.length ? out : undefined;
}

/** A direct child's declared shape: `rollup` (has its own children) or
 *  `leaf`. Undefined when nothing was declared for this child. */
export function childLinkShape(id: string): 'rollup' | 'leaf' | undefined {
  const c = active.childLinks?.find((x) => x.id === id);
  if (!c) return undefined;
  return c.hasChildren ? 'rollup' : 'leaf';
}

/** TEST SEAM. Sets the declared child links without a fetch. */
export function __setChildLinksForTest(links: ChildLinkEntry[] | undefined): void {
  active = { ...active, childLinks: links };
}

// Munition key: seven dot-joined non-negative integers.
const MUNITION_KEY_RE = /^\d+\.\d+\.\d+\.\d+\.\d+\.\d+\.\d+$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function isNonNegFinite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

function parseLoadBlock(raw: unknown, kind: 'asset' | 'variant'): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    console.warn(`[deployment] effectors.declaredLoad.${kind} dropped: not a mapping`);
    return out;
  }
  for (const [key, munitions] of Object.entries(raw)) {
    if (!isRecord(munitions)) {
      console.warn(`[deployment] effectors.declaredLoad.${kind}.${key} dropped: not a mapping`);
      continue;
    }
    const entry: Record<string, number> = {};
    for (const [mk, n] of Object.entries(munitions)) {
      if (!MUNITION_KEY_RE.test(mk) || !isNonNegFinite(n) || !Number.isInteger(n)) {
        console.warn(`[deployment] effectors.declaredLoad.${kind}.${key}.${mk} dropped: want a 7-part munition key and a non-negative integer`);
        continue;
      }
      entry[mk] = n;
    }
    out[key] = entry;
  }
  return out;
}

function parseUnitQuantity(raw: unknown, name: string): UnitQuantity | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isNonNegFinite(raw.value) || typeof raw.unit !== 'string' || !raw.unit.trim()) {
    console.warn(`[deployment] movement.standards.${name} dropped: want {value >= 0, unit}`);
    return undefined;
  }
  return { value: raw.value, unit: raw.unit.trim() };
}

function parseStandards(raw: unknown): Record<string, MoveStandard> {
  const out: Record<string, MoveStandard> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    console.warn('[deployment] movement.standards dropped: not a mapping');
    return out;
  }
  for (const [variant, s] of Object.entries(raw)) {
    if (!isRecord(s)) {
      console.warn(`[deployment] movement.standards.${variant} dropped: not a mapping`);
      continue;
    }
    const std: MoveStandard = {};
    for (const f of ['marchOrderS', 'emplaceS'] as const) {
      if (s[f] === undefined) continue;
      if (isNonNegFinite(s[f])) std[f] = s[f] as number;
      else console.warn(`[deployment] movement.standards.${variant}.${f} dropped: want a finite number >= 0`);
    }
    for (const f of ['fuelTank', 'fuelBurnPerKm'] as const) {
      const q = parseUnitQuantity(s[f], `${variant}.${f}`);
      if (q) std[f] = q;
    }
    out[variant] = std;
  }
  return out;
}

function parseUnits(raw: unknown): MoveUnit[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn('[deployment] movement.units dropped: not a list');
    return [];
  }
  const out: MoveUnit[] = [];
  raw.forEach((u, i) => {
    const name = isRecord(u) && typeof u.id === 'string' && u.id ? u.id : `#${i}`;
    if (
      !isRecord(u) || typeof u.id !== 'string' || !u.id.trim() ||
      typeof u.label !== 'string' || !u.label.trim() ||
      !Array.isArray(u.members) || !u.members.every((m) => typeof m === 'string')
    ) {
      console.warn(`[deployment] movement.units entry ${name} dropped: want id, label and a members list of strings`);
      return;
    }
    const unit: MoveUnit = { id: u.id.trim(), label: u.label.trim(), members: u.members as string[] };
    if (u.plannedMoveKm !== undefined) {
      if (isNonNegFinite(u.plannedMoveKm)) unit.plannedMoveKm = u.plannedMoveKm;
      else console.warn(`[deployment] movement.units entry ${name} plannedMoveKm dropped: want a finite number >= 0`);
    }
    out.push(unit);
  });
  return out;
}

/** Parses the whole `deployment.json` object for the move panel's declared
 *  inputs. Undefined when neither `effectors.declaredLoad` nor `movement` is
 *  present (older chart). A malformed entry is dropped alone, with a
 *  console.warn naming it; the rest of the block is kept. */
export function parseMoveInputs(raw: unknown): MoveInputs | undefined {
  if (!isRecord(raw)) return undefined;
  const eff = isRecord(raw.effectors) ? raw.effectors : undefined;
  const load = eff?.declaredLoad;
  const mv = raw.movement;
  if (load === undefined && mv === undefined) return undefined;
  if (load !== undefined && !isRecord(load)) {
    console.warn('[deployment] effectors.declaredLoad dropped: not a mapping');
  }
  if (mv !== undefined && !isRecord(mv)) {
    console.warn('[deployment] movement dropped: not a mapping');
  }
  const loadRec = isRecord(load) ? load : {};
  const mvRec = isRecord(mv) ? mv : {};
  return {
    declaredLoad: {
      asset: parseLoadBlock(loadRec.asset, 'asset'),
      variant: parseLoadBlock(loadRec.variant, 'variant'),
    },
    standards: parseStandards(mvRec.standards),
    units: parseUnits(mvRec.units),
  };
}

/** Declared move-panel inputs, or undefined on a chart that predates them. */
export function moveInputs(): MoveInputs | undefined {
  return active.moveInputs;
}

/** The declared movement unit this asset is a member of, if any. */
export function unitForAsset(assetId: string): MoveUnit | undefined {
  return active.moveInputs?.units.find((u) => u.members.includes(assetId));
}

/** TEST SEAM. Sets the declared move inputs without a fetch. */
export function __setMoveInputsForTest(m: MoveInputs | undefined): void {
  active = { ...active, moveInputs: m };
}

/** Parses `deployment.json`'s `cortex`. Anything but `{baseUrl}` with an
 *  http(s) string is treated as absent, with one console.warn. A trailing
 *  slash is stripped. EXPORTED FOR TESTS. */
export function parseCortex(raw: unknown): CortexConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const baseUrl = (raw as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    console.warn('[deployment] cortex dropped: baseUrl must be a string starting with http:// or https://');
    return undefined;
  }
  const out: CortexConfig = { baseUrl: baseUrl.replace(/\/+$/, '') };
  const idp = (raw as { idp?: unknown }).idp;
  if (idp !== undefined && idp !== null) {
    if (typeof idp === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(idp)) out.idp = idp;
    else console.warn('[deployment] cortex idp dropped: must match ^[a-z0-9][a-z0-9-]{0,62}$');
  }
  return out;
}

/** The configured cortex base URL, or undefined when cortex is not
 *  configured (in which case no cortex UI is drawn). */
export function cortexBaseUrl(): string | undefined {
  return active.cortex?.baseUrl;
}

/** The configured cortex idp marker, or undefined for none. */
export function cortexIdp(): string | undefined {
  return active.cortex?.idp;
}

/** TEST SEAM. Sets or clears the cortex config. */
export function __setCortexForTest(baseUrl: string | undefined, idp?: string): void {
  active = {
    ...active,
    cortex: baseUrl === undefined ? undefined : idp === undefined ? { baseUrl } : { baseUrl, idp },
  };
}

export function parseManualQa(raw: unknown): ManualQaConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const stub = (raw as Record<string, unknown>).stub;
  return typeof stub === 'boolean' ? { stub } : {};
}

/** A `figure` config is kept only when both pointers are strings that are
 *  RFC 6901 pointers (empty, or starting with "/"); anything else is
 *  omitted so the pane still renders, just without the Figure control. */
function parseFigureConfig(raw: unknown): ReleasedRecordsPaneConfig['figure'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  const isPointer = (x: unknown): x is string =>
    typeof x === 'string' && (x === '' || x.startsWith('/'));
  if ('hotspotPointer' in f && !('applicationStructureIdentPointer' in f)) {
    console.warn('[deployment] releasedRecordsPanes figure dropped: hotspotPointer was renamed applicationStructureIdentPointer', raw);
    return undefined;
  }
  if (!isPointer(f.icnPointer) || !isPointer(f.applicationStructureIdentPointer)) return undefined;
  return { icnPointer: f.icnPointer, applicationStructureIdentPointer: f.applicationStructureIdentPointer };
}

export function parseReleasedRecordsPanes(raw: unknown): ReleasedRecordsPaneConfig[] {
  if (!Array.isArray(raw)) return [];
  const isColumn = (x: unknown): x is ReleasedRecordsColumnConfig => {
    if (!x || typeof x !== 'object') return false;
    const c = x as Record<string, unknown>;
    return typeof c.header === 'string' && c.header.length > 0 && typeof c.pointer === 'string';
  };
  const out: ReleasedRecordsPaneConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== 'string' || !e.title.trim()) continue;
    if (typeof e.destination !== 'string' || !e.destination.trim()) continue;
    if (e.kind !== undefined && typeof e.kind !== 'string') continue;
    if (!Array.isArray(e.columns) || !e.columns.every(isColumn)) continue;
    const figure = parseFigureConfig(e.figure);
    out.push({
      title: e.title,
      destination: e.destination,
      kind: e.kind as string | undefined,
      columns: e.columns as ReleasedRecordsColumnConfig[],
      ...(figure ? { figure } : {}),
    });
  }
  return out;
}

/** Applies a branding overlay ({title?, logo?} from /branding/branding.json)
 *  on top of an already-resolved Deployment. Returns a COPY — `d` is never
 *  mutated.
 *
 *  Narrow and allow-listed on purpose: `b` is unauthenticated input (the
 *  /branding/ nginx location is deliberately ungated so the sign-in screen
 *  can show it), so this function is the only gate between that input and
 *  the running app. It touches `title` and `logo` ONLY, each applied only
 *  when it is a string that is non-empty after trim. Everything else about
 *  `b` — wrong type, not an object, extra keys — is ignored. In particular
 *  it must NEVER read fobs/map/tier/liveness off `b`: those carry topology,
 *  and topology must only ever arrive through the gated /deployment/ path. */
export function applyBranding(d: Deployment, b: unknown): Deployment {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ...d };
  const raw = b as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const logo = typeof raw.logo === 'string' ? raw.logo.trim() : '';
  return {
    ...d,
    title: title || d.title,
    logo: logo || d.logo,
  };
}

/** GET a same-origin JSON file and return it only when it is a plain object.
 *  Undefined on a non-ok response, a fetch or parse failure, or a result that
 *  is null or an array. That also covers a dev server answering with
 *  index.html, or the session gate redirecting to sign-in HTML. */
export async function fetchJsonObject(
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return undefined;
    const j: unknown = await res.json();
    if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
    return j as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Shallow-merge the chart's deployment.json (base) with the optional overlay
 *  bundle's (overlay). An overlay key replaces the whole base value for that
 *  key. Both undefined -> undefined (no file anywhere). */
export function mergeDeploymentSources(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined && overlay === undefined) return undefined;
  return { ...(base ?? {}), ...(overlay ?? {}) };
}

/**
 * Fetch the chart's deployment config (/deployment/) and the optional overlay
 * bundle's (/deployment-overlay/), merge them with the overlay winning per
 * top-level key, then the optional branding overlay (which overrides the
 * title and logo only — never topology), then apply document.title and the
 * favicon. Call once before the first render. Any failure (no file, 404, bad
 * JSON) leaves the prior state in place — it never throws.
 */
export async function loadDeployment(): Promise<void> {
  try {
    const [base, overlay] = await Promise.all([
      fetchJsonObject('/deployment/deployment.json'),
      fetchJsonObject('/deployment-overlay/deployment.json'),
    ]);
    const merged = mergeDeploymentSources(base, overlay);
    if (merged) {
      const j = merged as Partial<Deployment>;
      active = {
        title: j.title?.trim() || DEFAULT.title,
        logo: j.logo?.trim() || DEFAULT.logo,
        fobs: Array.isArray(j.fobs) ? j.fobs.filter(isValidFob) : DEFAULT.fobs,
        map: isValidDeploymentMap(j.map) ? j.map : undefined,
        liveness: mergeLiveness(j.liveness),
        // ABSENT -> implicit root. PRESENT-BUT-BAD -> undefined, which the
        // app renders as a configuration error rather than as any node.
        // parseTier cannot tell these apart (both arrive as undefined), so
        // the distinction is made here, where the raw object still says
        // whether the author wrote a `tier` key at all.
        tier: ('tier' in (j as object))
          ? parseTier((j as { tier?: unknown }).tier)
          : IMPLICIT_ROOT,
        releasedRecordsPanes: parseReleasedRecordsPanes(
          (j as { releasedRecordsPanes?: unknown }).releasedRecordsPanes,
        ),
        egressPane: parseEgressPane((j as { egressPane?: unknown }).egressPane),
        manualQa: parseManualQa((j as { manualQa?: unknown }).manualQa),
        cortex: parseCortex((j as { cortex?: unknown }).cortex),
        edges: parseEdgeAttachments((j as { edges?: unknown }).edges),
        childLinks: parseChildLinks((j as { childLinks?: unknown }).childLinks),
        tiers: parseTiers((j as { tiers?: unknown }).tiers),
        hq: parseHq((j as { hq?: unknown }).hq),
        moveInputs: parseMoveInputs(j),
      };
    }
  } catch {
    // No overlay reachable — keep the OpenDDIL defaults.
  }
  // Branding overlay — same-origin, ungated (see frontend/nginx.conf). Its
  // own try/catch: a bad or absent branding.json must leave `active`
  // (deployment.json's title/logo, or the OpenDDIL defaults) untouched.
  try {
    const res = await fetch('/branding/branding.json', { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      active = applyBranding(active, j);
    }
  } catch {
    // No branding overlay reachable — keep whatever title/logo we have.
  }
  document.title = active.title;
  if (active.logo) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = active.logo;
  }
}
