// =============================================================================
// tone — one colour vocabulary for the pill dot, the wires and the row marks
// =============================================================================
// OBSERVED STATE ONLY. Every tone here is a function of the observed
// edge_buffer_status indicator (lib/linkIndicator.ts) or the observed
// link_status readings (lib/linkStatus.ts). Commanded state -- the toggle, the
// applied toxics -- never feeds a tone: a link that was just cut and has not
// yet stopped carrying heartbeats is not drawn as severed.
//
// ok = emerald (nominal), warn = amber (degraded), bad = rose (critical),
// neutral = slate: "no confirmed answer" (unknown / stale), deliberately not
// borrowing the emerald/rose vocabulary of a confirmed up/severed link.
import type { LinkIndicatorKind } from '../../lib/linkIndicator';
import { allLinksDown, type LinkReading, type LinkState } from '../../lib/linkStatus';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export function toneFromIndicator(kind: LinkIndicatorKind): Tone {
  switch (kind) {
    case 'up': return 'ok';
    case 'severed': return 'bad';
    case 'probe_down': return 'warn';
    default: return 'neutral';
  }
}

export function toneFromLinkState(state: LinkState, declaredIdle = false): Tone {
  switch (state) {
    case 'up': return 'ok';
    case 'idle': return declaredIdle ? 'ok' : 'warn';
    case 'down': return 'bad';
    default: return 'neutral';
  }
}

/** Tone for a set of child links; null when there are none (they contribute
 *  nothing, rather than a misleading "ok"). Every link down is critical, some
 *  down or idle is degraded, anything unconfirmed is neutral. */
export function toneFromReadings(readings: readonly LinkReading[]): Tone | null {
  if (readings.length === 0) return null;
  if (allLinksDown(readings)) return 'bad';
  if (readings.some((r) => r.state === 'down')) return 'warn';
  if (readings.some((r) => r.state === 'idle' && !r.declaredIdle)) return 'warn';
  if (readings.some((r) => r.state === 'unknown')) return 'neutral';
  return 'ok';
}

const RANK: Record<Tone, number> = { ok: 0, neutral: 1, warn: 2, bad: 3 };

/** The worst of the given tones; neutral when none is given. */
export function worstTone(...tones: Array<Tone | null>): Tone {
  let worst: Tone | null = null;
  for (const t of tones) {
    if (t !== null && (worst === null || RANK[t] > RANK[worst])) worst = t;
  }
  return worst ?? 'neutral';
}

/** Text colour for an observed link state word (same colours LinkToggle's
 *  ChildLinkRow uses). */
export const STATE_CLASS: Record<LinkState, string> = {
  up: 'text-emerald-400',
  idle: 'text-amber-400',
  down: 'text-rose-400',
  unknown: 'text-slate-400',
};
