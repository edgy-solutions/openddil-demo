// usePostureTransitions -- posture transition CloudEvents (append-only).
// Source: tactical_events where type = 'openddil.posture.transition'.
// `subject` is the asset id; `data` carries the transition. Subjects are
// filtered client-side so the shape's where clause stays a plain type match.
import { useMemo } from 'react';
import { useTableShape, sqlLiteral, type ShapeResult } from './electric';
import type { PostureTransition } from '../lib/movePanel';

export const POSTURE_TRANSITION_TYPE = 'openddil.posture.transition';

function nullableStr(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function nullableBool(v: unknown): boolean | null {
  if (v === true || v === 't' || v === 'true') return true;
  if (v === false || v === 'f' || v === 'false') return false;
  return null;
}

export function mapPostureTransition(row: Record<string, unknown>): PostureTransition {
  let data: unknown = row.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    subject: String(row.subject ?? ''),
    from: String(d.from ?? 'unspecified'),
    to: String(d.to ?? 'unspecified'),
    at: String(d.at ?? ''),
    motionSince: nullableStr(d.motion_since),
    motion: nullableStr(d.motion),
    deploySignal: nullableBool(d.deploy_signal),
    speedMps: nullableNum(d.speed_mps),
    edgeId: nullableStr(d.edge_id),
    regionId: nullableStr(d.region_id),
    originatorNation: nullableStr(d.originator_nation) ?? undefined,
    releasableTo: Array.isArray(d.releasable_to) ? (d.releasable_to as unknown[]).map(String) : undefined,
  };
}

/** Posture transitions for the given assets (none when the list is empty). */
export function usePostureTransitions(assetIds: string[]): ShapeResult<PostureTransition> {
  const result = useTableShape('tactical_events', mapPostureTransition, {
    where: `type = ${sqlLiteral(POSTURE_TRANSITION_TYPE)}`,
  });
  const key = [...new Set(assetIds)].sort().join('\n');
  const data = useMemo(() => {
    const want = new Set(key ? key.split('\n') : []);
    return result.data.filter((t) => want.has(t.subject));
  }, [result.data, key]);
  return { ...result, data };
}
