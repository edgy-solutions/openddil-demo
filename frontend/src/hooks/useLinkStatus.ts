// useLinkStatus — reachability of each child tier's uplink, measured at the
// tier whose store holds the row.
// Source: link_status (one row per child tier id: edge-01, region-east, ...),
// written by the projector's link monitor from heartbeats that travel
// the same path as the data. Read the rows through classifyLink
// (lib/linkStatus.ts): a stale or missing row is 'unknown', never 'up'.
import { declaredLinkIds } from '../deployment';
import { num, sqlLiteral, useTableShape, type ShapeResult } from './electric';
import type { LinkStatusRow } from '../lib/linkStatus';

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

function mapLinkStatus(row: Record<string, any>): LinkStatusRow {
  return {
    id: String(row.id),
    link_state: String(row.link_state ?? ''),
    traffic: String(row.traffic ?? ''),
    // Electric returns booleans as the literal strings "t"/"f".
    declared_idle: row.declared_idle === true || row.declared_idle === 't',
    heartbeat_age_s: nullableNum(row.heartbeat_age_s),
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    bridge_lag: num(row.bridge_lag),
    updated_at: row.updated_at ?? null,
  };
}

export interface LinkStatusResult {
  /** Every link_status row, keyed by tier id. Empty until the first sync. */
  links: Map<string, LinkStatusRow>;
  isLoading: boolean;
  isError: boolean;
}

/** The where clause over the links a tier's screens show. One set per tier
 *  (sorted, deduplicated), so every call site on a screen asks for the SAME
 *  shape: distinct where clauses on one table would create several shapes,
 *  each logging the same writes. Undefined for no ids: a deployment that
 *  declares no links keeps the unfiltered read, because there is nothing to
 *  filter by and a wrong guess would hide a link. */
export function linkStatusWhere(ids: readonly string[]): string | undefined {
  const set = [...new Set(ids)].sort();
  return set.length ? `id IN (${set.map(sqlLiteral).join(', ')})` : undefined;
}

export function useLinkStatus(): LinkStatusResult {
  const where = linkStatusWhere(declaredLinkIds());
  const result: ShapeResult<LinkStatusRow> = useTableShape('link_status', mapLinkStatus, where ? { where } : {});
  return {
    links: new Map(result.data.map((r) => [r.id, r])),
    isLoading: result.isLoading,
    isError: result.isError,
  };
}
