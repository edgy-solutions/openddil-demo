// =============================================================================
// linkIndicator — the LINK label's observed state, independent of the slider
// =============================================================================
// Why this exists: Header / RegionalHeader computed `severed` as
// `status ? status.hq_link_severed : !link1` — when the edge_buffer_status
// shape hadn't synced yet, or was in error, the label silently fell back to
// the COMMANDED slider state and presented it as if it were observed. An
// operator could cut the link, watch edge_buffer_status go stale (projector
// down, Electric shape erroring), and still see the label agree with the
// slider — not because anything confirmed it, but because the fallback
// manufactured the agreement.
//
// The fix: the indicator is a pure function of the observed row + isError +
// now. It does not take the slider's state as an input at all — that is
// what makes "the label never follows the slider" true by construction
// rather than by convention. Outcomes, in priority order:
//   unknown     no row has arrived yet (status === null)
//   stale       a row exists, but now - updated_at > STALE_S, or the shape
//               itself is in error — "I had an answer, I can no longer
//               vouch for it", rendered neutral/grey rather than red/green.
//   probe_down  fresh row, the probe itself is unhealthy (today's
//               PROBE DOWN case, preserved)
//   severed     fresh row, hq_link_severed === true
//   up          fresh row, hq_link_severed === false
//
// The projector writes edge_buffer_status every 2s; STALE_S=10s is 5x that
// — comfortably past a single missed write, short enough that a genuinely
// dead monitor is caught within one operator glance. Exported so Header /
// RegionalHeader re-evaluate on the same cadence (see hooks/useLinkIndicator).
//
// Framework-free: see hooks/useLinkIndicator.ts for why (same reasoning as
// lib/wanLink.ts).
export const STALE_S = 10;

export type LinkIndicatorKind = 'unknown' | 'stale' | 'probe_down' | 'severed' | 'up';

export interface LinkIndicatorStatus {
  hq_link_severed: boolean;
  probe_healthy: boolean;
  updated_at: string | null;
}

export function classifyLinkIndicator(
  status: LinkIndicatorStatus | null,
  isError: boolean,
  nowMs: number,
): LinkIndicatorKind {
  if (status === null) return 'unknown';

  const updatedMs = status.updated_at ? Date.parse(status.updated_at) : NaN;
  const ageS = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / 1000 : Infinity;
  if (isError || ageS > STALE_S) return 'stale';

  if (!status.probe_healthy) return 'probe_down';
  return status.hq_link_severed ? 'severed' : 'up';
}
