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
// now + the previously-rendered kind (for hysteresis). It does not take
// the slider's state as an input at all — that is what makes "the label
// never follows the slider" true by construction rather than by
// convention. Outcomes, in priority order:
//   unknown     no row has arrived yet (status === null)
//   stale       a row exists, but it's too old (age > STALE_ENTER_S, or
//               > STALE_EXIT_S if the label is already showing stale), or
//               the shape itself is in error — "I had an answer, I can no
//               longer vouch for it", rendered neutral/grey rather than
//               red/green.
//   probe_down  fresh row, the probe itself is unhealthy (today's
//               PROBE DOWN case, preserved)
//   severed     fresh row, hq_link_severed === true
//   up          fresh row, hq_link_severed === false
//
// The projector writes edge_buffer_status every 2.0s. On an edge page the
// browser does NOT see that cadence: plain HTTP means Chrome speaks
// HTTP/1.1 with 6 sockets per host, an edge page holds 8 live Electric
// shapes, and each quiet shape parks its socket for Electric's 20s
// long-poll. The edge_buffer_status request queues behind those for up to
// 20.1s (measured via CDP sendStart) before the server answers in
// milliseconds. So the row the browser holds ages ~0 -> ~22s in a sawtooth
// even on a healthy link, not the ~2s the projector actually writes at.
// STALE_S=10s cut through the middle of that sawtooth and flickered the
// label about half the time with nothing wrong.
//
// STALE_ENTER_S=30s clears the measured ~22s peak with margin; STALE_EXIT_S
// =10s (hysteresis, not a single cutoff) means once a row is flagged stale
// it stays stale until it's genuinely fresh again, so a row doesn't
// flicker back out of stale on the leading edge of the same queuing delay
// that put it there. Exported so Header / RegionalHeader re-evaluate on
// the same cadence (see hooks/useLinkIndicator).
//
// What "stale" does and doesn't mean: hq_link_severed / probe_healthy are
// decided server-side, with their own hysteresis, against this tier's own
// uplink to its parent (for a leaf edge, that parent is its region, not
// HQ) — the browser never re-derives that verdict. Staleness only answers
// a narrower question: is the browser's copy of that verdict recent enough
// to still vouch for? An old copy is withheld (shown neutral/grey) rather
// than presented as if it were current.
//
// Framework-free: see hooks/useLinkIndicator.ts for why (same reasoning as
// lib/wanLink.ts).
export const STALE_ENTER_S = 30;
export const STALE_EXIT_S = 10;

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
  prev?: LinkIndicatorKind,
): LinkIndicatorKind {
  if (status === null) return 'unknown';
  if (isError) return 'stale';

  const updatedMs = status.updated_at ? Date.parse(status.updated_at) : NaN;
  const ageS = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / 1000 : Infinity;
  const staleThresholdS = prev === 'stale' ? STALE_EXIT_S : STALE_ENTER_S;
  if (ageS > staleThresholdS) return 'stale';

  if (!status.probe_healthy) return 'probe_down';
  return status.hq_link_severed ? 'severed' : 'up';
}

// What classifyLinkIndicator reads, flattened to primitives so two renders
// can be compared by value. The status row is a new object on every render
// (useEdgeBuffer maps the shape's rows each time), so comparing it by
// identity never settles.
export interface LinkIndicatorInputs {
  present: boolean;
  severed: boolean | null;
  healthy: boolean | null;
  updatedAt: string | null;
  isError: boolean;
  nowMs: number;
}

export function linkIndicatorInputs(
  status: LinkIndicatorStatus | null,
  isError: boolean,
  nowMs: number,
): LinkIndicatorInputs {
  return {
    present: status !== null,
    severed: status?.hq_link_severed ?? null,
    healthy: status?.probe_healthy ?? null,
    updatedAt: status?.updated_at ?? null,
    isError,
    nowMs,
  };
}

export function sameLinkIndicatorInputs(a: LinkIndicatorInputs, b: LinkIndicatorInputs): boolean {
  return (
    a.present === b.present &&
    a.severed === b.severed &&
    a.healthy === b.healthy &&
    a.updatedAt === b.updatedAt &&
    a.isError === b.isError &&
    a.nowMs === b.nowMs
  );
}
