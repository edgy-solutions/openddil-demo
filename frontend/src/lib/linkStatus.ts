// Per-FOB link state, classified from a link_status row.
//
// link_status is written by the measuring tier's link monitor (HQ for every
// link, each tier for its direct children), one row per tier id, from
// heartbeats that travel the same path as the data. This module is the
// pure reading of such a row: no hooks, no clock of its own (callers pass
// `nowMs`), so every case is directly testable.
//
// Absence is never "up". A missing row, a row the monitor has stopped
// refreshing, or a state this code does not recognise all read 'unknown'.

export type LinkState = 'up' | 'idle' | 'down' | 'unknown';

export interface LinkStatusRow {
  id: string;
  link_state: string;
  traffic: string;
  declared_idle: boolean;
  heartbeat_age_s: number | null;
  last_heartbeat_at: string | null;
  bridge_lag: number;
  updated_at: string | null;
}

export interface LinkReading {
  state: LinkState;
  /** The link's idleness was declared in the deployment; only labels use it. */
  declaredIdle: boolean;
}

/** A row not refreshed within this window means the monitor is not writing. */
export const LINK_ROW_STALE_MS = 30_000;

const KNOWN: ReadonlySet<string> = new Set(['up', 'idle', 'down', 'unknown']);

export function classifyLink(row: LinkStatusRow | undefined, nowMs: number): LinkReading {
  if (!row) return { state: 'unknown', declaredIdle: false };
  const updated = row.updated_at ? Date.parse(row.updated_at) : NaN;
  if (!Number.isFinite(updated) || nowMs - updated > LINK_ROW_STALE_MS) {
    return { state: 'unknown', declaredIdle: false };
  }
  const state = KNOWN.has(row.link_state) ? (row.link_state as LinkState) : 'unknown';
  return { state, declaredIdle: row.declared_idle === true };
}

/** Age in seconds of the link's freshest heartbeat, or null when unreadable.
 *  Both timestamps are server-side (updated_at is the projector's tick,
 *  last_heartbeat_at the sender's emitted_at), so no browser clock enters it. */
export function linkDataAgeS(row: LinkStatusRow | undefined): number | null {
  if (!row || !row.updated_at || !row.last_heartbeat_at) return null;
  const age = (Date.parse(row.updated_at) - Date.parse(row.last_heartbeat_at)) / 1000;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

export function formatDataAge(s: number | null): string {
  return s === null ? '—' : `${s.toFixed(1)}s`;
}

/** The reading for one FOB: the row whose id is the FOB's edge id. */
export function linkForFob(
  rows: ReadonlyMap<string, LinkStatusRow>,
  edgeId: string,
  nowMs: number,
): LinkReading {
  return classifyLink(rows.get(edgeId), nowMs);
}

export function linkStateWord(link: LinkReading): string {
  if (link.state === 'idle') return link.declaredIdle ? 'IDLE · declared' : 'IDLE';
  return link.state.toUpperCase();
}

export interface LinkCounts {
  up: number;
  idle: number;
  down: number;
  unknown: number;
}

export function summarizeLinks(links: readonly LinkReading[]): LinkCounts {
  const c: LinkCounts = { up: 0, idle: 0, down: 0, unknown: 0 };
  for (const l of links) c[l.state]++;
  return c;
}

export function summaryText(c: LinkCounts): string {
  const base = `${c.up} UP · ${c.idle} IDLE · ${c.down} DOWN`;
  return c.unknown > 0 ? `${base} · ${c.unknown} UNKNOWN` : base;
}

/** True only when there is at least one link and every one is down. */
export function allLinksDown(links: readonly LinkReading[]): boolean {
  return links.length > 0 && links.every((l) => l.state === 'down');
}
