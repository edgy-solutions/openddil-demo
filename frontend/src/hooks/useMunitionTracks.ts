// useMunitionTracks -- in-flight munitions, one row per munition_asset_id.
// Source: munition_track, filtered to terminal_state IS NULL (ADR-0049). The
// map dot and the in-flight number read these same rows. A track is not an
// asset: it has no fleet row, no detail view and no callout.
import { num, parseTextArray, useTableShape, type ShapeResult } from './electric';

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

export function mapMunitionTrack(row: Record<string, unknown>): MunitionTrack {
  return {
    munitionAssetId: str(row.munition_asset_id),
    launcherAssetId: nullableStr(row.launcher_asset_id),
    eventUrn: nullableStr(row.event_urn),
    munitionType: str(row.munition_type),
    ecefX: nullableNum(row.ecef_x),
    ecefY: nullableNum(row.ecef_y),
    ecefZ: nullableNum(row.ecef_z),
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
