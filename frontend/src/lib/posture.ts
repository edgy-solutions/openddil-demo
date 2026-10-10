// Asset posture (movement / emplacement state) and how long it has held.
// Pure helpers live here so the label, colour and duration rules are
// unit-testable and every tier renders the same words for the same value.
import { useEffect, useState } from 'react';

export type PostureStatus =
  | 'unspecified'
  | 'emplaced'
  | 'march_ordered'
  | 'moving'
  | 'emplacing';

/** Display order; unspecified is excluded because it is "no data", not a state. */
export const POSTURE_ORDER: PostureStatus[] = ['emplaced', 'march_ordered', 'moving', 'emplacing'];

/** Anything the store hands us that is not a known value reads as unspecified,
 *  so a newer producer value never renders as a made-up state. */
export function normalizePosture(raw: unknown): PostureStatus {
  return typeof raw === 'string' && (POSTURE_ORDER as string[]).includes(raw)
    ? (raw as PostureStatus)
    : 'unspecified';
}

export function postureLabel(s: PostureStatus): string {
  switch (s) {
    case 'emplaced': return 'EMPLACED';
    case 'march_ordered': return 'MARCH ORDERED';
    case 'moving': return 'MOVING';
    case 'emplacing': return 'EMPLACING';
    default: return '—';
  }
}

export function postureClass(s: PostureStatus): string {
  switch (s) {
    case 'emplaced': return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'march_ordered': return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'moving': return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
    case 'emplacing': return 'bg-violet-500/20 text-violet-300 border-violet-500/40';
    default: return 'bg-slate-700/30 text-slate-400 border-slate-600';
  }
}

/** Compact elapsed time since `since`. Null when unknown, unparseable, or in
 *  the future beyond clock-skew slack (5 s), so a skewed clock shows nothing
 *  rather than a negative or invented duration. */
export function timeInState(since: string | null, nowMs: number): string | null {
  if (!since) return null;
  const t = new Date(since).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = nowMs - t;
  if (diffMs < -5000) return null;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** "EMPLACED 4m 12s"; unspecified is just the dash, with no time. */
export function postureText(s: PostureStatus, since: string | null, nowMs: number): string {
  if (s === 'unspecified') return postureLabel(s);
  const t = timeInState(since, nowMs);
  return t ? `${postureLabel(s)} ${t}` : postureLabel(s);
}

export function countPosture(
  rows: { posture_status: PostureStatus }[],
): Record<PostureStatus, number> {
  const out: Record<PostureStatus, number> = {
    unspecified: 0, emplaced: 0, march_ordered: 0, moving: 0, emplacing: 0,
  };
  for (const r of rows) out[r.posture_status] += 1;
  return out;
}

/** Date.now() re-read on an interval so time-in-state counters tick between
 *  data updates. */
export function usePostureClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
