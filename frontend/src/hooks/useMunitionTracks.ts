// useMunitionTracks -- in-flight munitions, one row per munition_asset_id.
// Source: munition_track, filtered to terminal_state IS NULL (ADR-0049). The
// map dot and the in-flight number read these same rows. A track is not an
// asset: it has no fleet row, no detail view and no callout.
import { useEffect, useState } from 'react';
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
const FEED_ADVANCE_MS = 15 * 60_000;

/**
 * In flight plus anything that ended since mount (minus 10 s), for the trail
 * endings only. Counts and lists stay on useInFlightMunitionTracks. The cut-off
 * is a fixed literal (Electric where clauses cannot call now()); it moves
 * forward every 15 min so the shape stays bounded over a long session.
 */
export function useMunitionTrackFeed(): ShapeResult<MunitionTrack> {
  const [sinceMs, setSinceMs] = useState(() => Date.now() - FEED_LEAD_MS);
  useEffect(() => {
    const id = setInterval(() => setSinceMs(Date.now() - FEED_LEAD_MS), FEED_ADVANCE_MS);
    return () => clearInterval(id);
  }, []);
  const sinceIso = new Date(sinceMs).toISOString();
  const result = useTableShape('munition_track', mapMunitionTrack, {
    where: `terminal_state IS NULL OR terminated_at > ${sqlLiteral(sinceIso)}::timestamptz`,
  });
  // A moved cut-off starts a new shape whose data is empty until it syncs.
  // Hold the previous rows meanwhile so no in-flight track reads as vanished.
  const [held, setHeld] = useState<MunitionTrack[]>([]);
  const hold = result.isLoading && result.data.length === 0 && held.length > 0;
  if (!hold && held !== result.data && (held.length > 0 || result.data.length > 0)) setHeld(result.data);
  return hold ? { ...result, data: held } : result;
}
