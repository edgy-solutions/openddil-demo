// =============================================================================
// assetTier — 5-tier asset liveness classifier
// =============================================================================
// Pure function over (last_sample_at, health_state, edge_link_severed,
// thresholds, now). No DOM, no Date.now() — `now` is an injected
// epoch-millis so the same call is deterministic and unit-testable.
//
// Tiers, ordered worst-to-best:
//
//   LOST       no sample for > lost_after_s. Hidden from the 3D scene.
//              Still queryable for forensics; the pulldown labels it.
//
//   COMM_LOST  no sample for > stale_after_s AND the asset's edge link
//              is severed (edge_buffer_status.hq_link_severed = true).
//              "We know why we're not hearing from this." 3D dim +
//              amber outline.
//
//   STALE      no sample for > stale_after_s, link UP. "We expected to
//              hear from it, we didn't." 3D dim + slate outline.
//
//   DEGRADED   recent sample, but operational_state.health_state ==
//              FAULT or FAILED. The asset is alive but reporting that
//              it's broken. 3D amber strobe (already supported via the
//              schematic degraded animation).
//
//   ACTIVE    recent sample, health is OK / null. Full color.
//
// Order of precedence in classifyAssetTier: time-based degrade (LOST,
// COMM_LOST, STALE) trumps DEGRADED -- a launcher reporting FAULT and
// then going silent is COMM_LOST/STALE/LOST, not DEGRADED. ACTIVE is
// the residual.
//
// Recovery hysteresis (lifting from STALE/COMM_LOST/LOST back to
// ACTIVE) lives in a separate stateful tracker -- see
// useAssetLivenessTracker. The classifier here is stateless; the hook
// gates the upward transition on N consecutive samples within
// recovery_window_s.

import type { LivenessThresholds } from '../deployment';

export type AssetTier =
  | 'ACTIVE'
  | 'DEGRADED'
  | 'STALE'
  | 'COMM_LOST'
  | 'LOST';

/** Worst-to-best ordering for severity comparisons + count summaries. */
export const TIER_ORDER: AssetTier[] = [
  'LOST',
  'COMM_LOST',
  'STALE',
  'DEGRADED',
  'ACTIVE',
];

/** A degraded-health signal from the asset's own OperationalState.
 *  POWER_STATE_OFF doesn't count -- a powered-off asset is operating
 *  as intended for maintenance. Only FAULT/FAILED mark the asset as
 *  "alive and broken." */
export function isDegradedHealth(healthState: string | null | undefined): boolean {
  return healthState === 'HEALTH_STATE_FAULT'
      || healthState === 'HEALTH_STATE_FAILED';
}

export interface ClassifyInput {
  /** ISO-8601 timestamp of the most recent sample. Null for assets
   *  whose last_sample_at column is NULL (rare; treat as never-seen
   *  -> immediate LOST). */
  lastSampleAt: string | null | undefined;
  /** OperationalState.health_state value, or null when the producer
   *  hasn't supplied operational_state at all. */
  healthState: string | null | undefined;
  /** Whether the asset's attributed edge link is currently severed.
   *  Read from edge_buffer_status; per-edge in production, single
   *  global value in compose. False (link up) when the asset has no
   *  attributed edge or no status is known yet. */
  edgeLinkSevered: boolean;
  /** Current epoch ms. Caller-supplied so unit tests pin time
   *  precisely without monkey-patching globals. */
  nowMs: number;
}

/** Pure classifier. Returns the tier the asset deserves at `nowMs`
 *  given its instantaneous inputs. Stateless -- no hysteresis;
 *  see useAssetLivenessTracker for the recovery-side hysteresis. */
export function classifyAssetTier(
  input: ClassifyInput,
  thresholds: LivenessThresholds,
): AssetTier {
  const { lastSampleAt, healthState, edgeLinkSevered, nowMs } = input;

  // No timestamp -> the row exists in postgres but has no observation
  // ever. Treat as LOST so it doesn't render in the 3D scene; the
  // pulldown still shows it for triage.
  if (!lastSampleAt) return 'LOST';

  const sampleMs = Date.parse(lastSampleAt);
  if (!Number.isFinite(sampleMs)) return 'LOST';

  const ageS = (nowMs - sampleMs) / 1000;

  // Time-based downgrade wins over DEGRADED -- a faulting asset that
  // also goes silent is LOST/COMM_LOST/STALE, not DEGRADED.
  if (ageS > thresholds.lost_after_s) return 'LOST';
  if (ageS > thresholds.stale_after_s) {
    return edgeLinkSevered ? 'COMM_LOST' : 'STALE';
  }

  // Recent sample. DEGRADED if the asset itself reports broken.
  if (isDegradedHealth(healthState)) return 'DEGRADED';

  return 'ACTIVE';
}

/** Whether a tier should be RENDERED in the 3D scene. LOST drops out
 *  entirely; everything else renders (with per-tier opacity / outline
 *  applied by the renderer). */
export function isTierVisibleIn3D(tier: AssetTier): boolean {
  return tier !== 'LOST';
}

/** Per-tier opacity for the 3D scene. ACTIVE/DEGRADED render at full
 *  presence; STALE/COMM_LOST dim so the operator can still see them
 *  but they recede behind the live fleet. LOST returns 0 (caller
 *  should isTierVisibleIn3D-gate first, but this stays consistent if
 *  someone draws a LOST asset anyway). */
export function tierOpacity(tier: AssetTier): number {
  switch (tier) {
    case 'ACTIVE':    return 1.0;
    case 'DEGRADED':  return 1.0;
    case 'STALE':     return 0.45;
    case 'COMM_LOST': return 0.45;
    case 'LOST':      return 0.0;
  }
}

/** Per-tier outline-ring color hint. Renderers map this to a concrete
 *  THREE.Color or CSS class; this layer just names the role so the
 *  visual scheme stays consistent across the 3D scene + the pulldown
 *  + the tier-count badge.
 *
 *  STALE outline is slate (mute "we don't know"); COMM_LOST is amber
 *  (warn "we know why, it's the link"); LOST renders no outline
 *  (it's hidden anyway). */
export type TierOutline = 'severity' | 'slate' | 'amber' | 'none';

export function tierOutline(tier: AssetTier): TierOutline {
  switch (tier) {
    case 'ACTIVE':    return 'severity';
    case 'DEGRADED':  return 'severity';
    case 'STALE':     return 'slate';
    case 'COMM_LOST': return 'amber';
    case 'LOST':      return 'none';
  }
}

/** Short two-letter code for compact tier-count badges
 *  (`AC 47 · DG 3 · ST 12 · CL 0 · LO 8`). Mnemonic without taking
 *  the whole header strip's width. */
export function tierShortCode(tier: AssetTier): string {
  switch (tier) {
    case 'ACTIVE':    return 'AC';
    case 'DEGRADED':  return 'DG';
    case 'STALE':     return 'ST';
    case 'COMM_LOST': return 'CL';
    case 'LOST':      return 'LO';
  }
}

/** Human-readable tier label for tooltips + pulldown suffixes. */
export function tierLabel(tier: AssetTier): string {
  switch (tier) {
    case 'ACTIVE':    return 'Active';
    case 'DEGRADED':  return 'Degraded';
    case 'STALE':     return 'Stale';
    case 'COMM_LOST': return 'Comm Lost';
    case 'LOST':      return 'Lost';
  }
}

/** Recovery-hysteresis gate. Decides whether to ACCEPT the
 *  classifier's candidate tier or HOLD the previous one.
 *
 *  Rules:
 *    * First sighting (lastTier === null) -> always accept candidate.
 *      The hook has no history yet; nothing to hysterese against.
 *    * Candidate is silent (STALE/COMM_LOST/LOST) -> accept. Downgrades
 *      fire immediately; we never delay a "you've gone quiet" signal.
 *    * Was live (ACTIVE/DEGRADED), candidate is live -> accept.
 *      ACTIVE <-> DEGRADED is health-driven, not comms-driven.
 *    * Was silent, candidate is live -> HYSTERESIS: accept only when
 *      `samplesInWindow >= recoverySamplesN`. Below that bar, hold the
 *      previous silent tier so a momentary reconnect can't yank the
 *      asset back to ACTIVE on a single sample.
 *
 *  Pure: same inputs => same output. State (the sample window count,
 *  the previous tier) lives in the calling hook's per-asset tracker.
 */
export function applyRecoveryHysteresis(
  lastTier: AssetTier | null,
  candidate: AssetTier,
  samplesInWindow: number,
  recoverySamplesN: number,
): AssetTier {
  if (lastTier === null) return candidate;

  const candidateIsLive = candidate === 'ACTIVE' || candidate === 'DEGRADED';
  if (!candidateIsLive) return candidate;

  const wasSilent =
    lastTier === 'STALE' || lastTier === 'COMM_LOST' || lastTier === 'LOST';
  if (!wasSilent) return candidate;

  // Recovery transition. Gate on accumulated samples.
  return samplesInWindow >= recoverySamplesN ? candidate : lastTier;
}
