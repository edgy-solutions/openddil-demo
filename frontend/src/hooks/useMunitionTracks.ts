// useMunitionTracks -- in-flight munitions, one row per munition_asset_id.
// Source: munition_track, filtered to terminal_state IS NULL (ADR-0049). The
// map dot and the in-flight number read these same rows. A track is not an
// asset: it has no fleet row, no detail view and no callout.
import { useMemo, useState } from 'react';
import { num, parseTextArray, sqlLiteral, useTableShape, type ShapeResult } from './electric';

export interface MunitionTrack {
  munitionAssetId: string;
  launcherAssetId: string | null;
  eventUrn: string | null;
  /** DIS munition 7-tuple, as stored. */
  munitionType: string;
  /** ECEF metres; null when the row carries no usable position. */
  ecefX: number | null;
  ecefY: number | null;
  ecefZ: number | null;
  /** Last <=10 ECEF samples, flat [x0,y0,z0,...], oldest first; null on rows that predate the column. */
  trailEcef: number[] | null;
  firstSeenAt: string;
  lastSampleAt: string;
  lastHeardAt: string;
  /** null while in flight. */
  terminalState: string | null;
  detonationResult: string | null;
  terminatedAt: string | null;
  lateTerminal: boolean;
  edgeId: string | null;
  regionId: string | null;
  /** Releasability labels as stored (ADR-0029); null when unlabelled. */
  originatorNation: string | null;
  releasableTo: string[] | null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function nullableStr(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = num(v, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * trail_ecef (double precision[]) -> flat number[]. Accepts a number[], a
 * numeric-string[] or the Postgres literal `{1.5,2,-3e+06}`. Null for null,
 * empty, any non-finite entry, or a length that is not a multiple of 3.
 */
export function parseTrailEcef(raw: unknown): number[] | null {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    const inner = t.slice(1, -1).trim();
    items = inner === '' ? [] : inner.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  } else return null;
  if (items.length === 0 || items.length % 3 !== 0) return null;
  const out: number[] = [];
  for (const it of items) {
    if (it === null || it === undefined || it === '' || typeof it === 'boolean') return null;
    const n = typeof it === 'number' ? it : typeof it === 'string' ? Number(it) : Number.NaN;
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

export function mapMunitionTrack(row: Record<string, unknown>): MunitionTrack {
  return {
    munitionAssetId: str(row.munition_asset_id),
    launcherAssetId: nullableStr(row.launcher_asset_id),
    eventUrn: nullableStr(row.event_urn),
    munitionType: str(row.munition_type),
    ecefX: nullableNum(row.ecef_x),
    ecefY: nullableNum(row.ecef_y),
    ecefZ: nullableNum(row.ecef_z),
    trailEcef: parseTrailEcef(row.trail_ecef),
    firstSeenAt: str(row.first_seen_at),
    lastSampleAt: str(row.last_sample_at),
    lastHeardAt: str(row.last_heard_at),
    terminalState: nullableStr(row.terminal_state),
    detonationResult: nullableStr(row.detonation_result),
    terminatedAt: nullableStr(row.terminated_at),
    lateTerminal: row.late_terminal === true || row.late_terminal === 'true' || row.late_terminal === 't',
    edgeId: nullableStr(row.edge_id),
    regionId: nullableStr(row.region_id),
    originatorNation: nullableStr(row.originator_nation),
    releasableTo: parseTextArray(row.releasable_to),
  };
}

/** Tracks still in flight at this tier's scope. */
export function useInFlightMunitionTracks(): ShapeResult<MunitionTrack> {
  return useTableShape('munition_track', mapMunitionTrack, {
    where: 'terminal_state IS NULL',
  });
}

const FEED_LEAD_MS = 10_000;

/** The UTC midnight at or before `nowMs - FEED_LEAD_MS`, as an ISO string. */
export function feedCutoffIso(nowMs: number): string {
  const d = new Date(nowMs - FEED_LEAD_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

let pageCutoffIso: string | null = null;
function pageCutoff(): string {
  if (pageCutoffIso === null) pageCutoffIso = feedCutoffIso(Date.now());
  return pageCutoffIso;
}
/** Test-only: forget the page cut-off. */
export function resetPageCutoffForTests(): void {
  pageCutoffIso = null;
}

/**
 * In flight plus anything that ended since mount (minus 10 s), for the trail
 * endings only. Counts and lists stay on useInFlightMunitionTracks. The where
 * is fixed for the page's life: each distinct where is a shape Electric keeps
 * and writes to. Its cut-off is the UTC day, so screens share one shape and at
 * most one new definition per UTC day is made per tier. The window is applied
 * on the client.
 */
export function useMunitionTrackFeed(): ShapeResult<MunitionTrack> {
  const [sinceMs] = useState(() => Date.now() - FEED_LEAD_MS);
  const result = useTableShape('munition_track', mapMunitionTrack, {
    where: `terminal_state IS NULL OR terminated_at > ${sqlLiteral(pageCutoff())}::timestamptz`,
  });
  const data = useMemo(
    () =>
      result.data.filter(
        (t) => t.terminalState === null || Date.parse(t.terminatedAt ?? '') > sinceMs,
      ),
    [result.data, sinceMs],
  );
  return useMemo(() => ({ ...result, data }), [result, data]);
}
