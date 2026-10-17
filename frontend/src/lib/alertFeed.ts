// Pure helpers for the tactical event feed (no React).
import type { TacticalEvent } from '../hooks';

export const SEVERITY_TRANSITION_TYPE = 'openddil.logistics.v1.severity-transition';

export interface FeedRow {
  /** newest event of the group */
  event: TacticalEvent;
  count: number;
  /** time of the oldest event in the group */
  firstTime: string;
}

/** `LOGISTICS_SEVERITY_CRITICAL` -> `CRITICAL`; '' for empty. */
export function shortSeverity(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/^(LOGISTICS_SEVERITY_|CONFIG_STATUS_)/, '');
}

/** "DEGRADED → CRITICAL" for a severity-transition; null for any other type. */
export function describeTransition(e: TacticalEvent): string | null {
  if (e.type !== SEVERITY_TRANSITION_TYPE) return null;
  const next = shortSeverity(e.severity);
  const prevRaw = e.data?.previous_severity;
  const prev = shortSeverity(typeof prevRaw === 'string' ? prevRaw : null);
  if (!prev) return next || null;
  return next ? `${prev} → ${next}` : prev;
}

/** What caused the event: the factor description, else the factor id, else null. */
export function eventCause(e: TacticalEvent): string | null {
  const d = e.data?.top_factor_description;
  if (typeof d === 'string' && d) return d;
  const f = e.data?.top_factor;
  if (typeof f === 'string' && f) return f;
  return null;
}

interface Group {
  row: FeedRow;
  oldestMs: number;
}

/**
 * Fold repeats of the same (subject, type, severity) into one row.
 * Input is newest first. An event joins the open group for its key when it
 * is within `windowMs` of that group's oldest member; otherwise it starts a
 * new group. Events of other keys in between do not break a group. Rows
 * follow each group's newest event. O(n).
 */
export function collapseRepeats(
  events: TacticalEvent[],
  windowMs = 30 * 60_000,
): FeedRow[] {
  const rows: FeedRow[] = [];
  const open = new Map<string, Group>();
  for (const event of events) {
    const key = JSON.stringify([event.subject, event.type, event.severity]);
    const ms = Date.parse(event.time);
    const g = open.get(key);
    if (g && !Number.isNaN(ms) && !Number.isNaN(g.oldestMs) && g.oldestMs - ms <= windowMs) {
      g.row.count += 1;
      g.row.firstTime = event.time;
      g.oldestMs = ms;
      continue;
    }
    const row: FeedRow = { event, count: 1, firstTime: event.time };
    rows.push(row);
    open.set(key, { row, oldestMs: ms });
  }
  return rows;
}
