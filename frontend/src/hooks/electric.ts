// =============================================================================
// ElectricSQL shape-hook foundation (Phase 4b)
// =============================================================================
// Every edge/regional/HQ view reads pipeline state through ElectricSQL
// Shapes — there is no polling, and no Faust HTTP path. The projector
// (openddil-projector) populates the Postgres read-model tables; Electric
// exposes them as Shapes; these hooks subscribe.
//
// Electric quirk this module absorbs: numeric columns come back as STRINGS
// (Electric is precision-conservative), while jsonb columns come back as
// parsed objects. `num()` coerces a known-numeric field; per-table hooks
// use it so components get clean typed data.
// =============================================================================
import { useEffect } from 'react';
import { reportShapeError, clearShapeError } from '../lib/shapeErrors';
import { isUnlabelable } from '../lib/labeledTables';
import { useShape } from '@electric-sql/react';

// VITE_ELECTRIC_URL is relative ("/electric/v1/shape") for same-origin Helm
// deploys so it works behind any ingress host. The Electric client runs
// `new URL()` on this value, which rejects a relative URL — resolve it
// against the page origin here. An already-absolute value (docker-compose's
// http://localhost:5133/...) passes through unchanged.
const rawElectricUrl =
  import.meta.env.VITE_ELECTRIC_URL ?? 'http://localhost:5133/v1/shape';
export const ELECTRIC_URL = new URL(
  rawElectricUrl,
  window.location.origin,
).toString();

/** Uniform return shape for every OpenDDIL shape hook. */
export interface ShapeResult<T> {
  data: T[];
  isLoading: boolean;
  isError: boolean;
  /** Unix ms of last successful sync; undefined while isLoading. */
  lastSyncedAt?: number;
}

/** Coerce Electric's string-numeric to a number. Empty/null -> fallback. */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * SQL string literal with single quotes escaped — for inlining a
 * controlled value (e.g. an asset_id) directly into an Electric `where`
 * clause.
 *
 * Phase 4c.5 fix: the per-asset hooks previously used Electric's
 * positional-param path (`where: 'asset_id = $1'` + a nested
 * `params: { 1: assetId }` object). That path behaved inconsistently —
 * the where-filtered shapes returned empty in the React client even
 * though the equivalent HTTP request returned data — so the maintainer
 * view showed "No CM state" for assets that demonstrably had it.
 * Inlining a quote-escaped literal is idiomatic for Electric (its docs
 * show literal `where` clauses) and sidesteps the nested-params path
 * entirely. asset_ids come from our own pipeline, not user free-text,
 * but the quote-escaping keeps it injection-safe regardless.
 */
export function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

interface TableShapeOptions {
  /** Complete SQL WHERE clause, e.g. `asset_id = 'dis:1:1:4773'`. */
  where?: string;
}

/**
 * Subscribe to one Postgres table as an Electric Shape. `map` normalises
 * each raw row (string-numeric coercion, jsonb passthrough) into T.
 */
export function useTableShape<T>(
  table: string,
  map: (row: Record<string, any>) => T,
  opts: TableShapeOptions = {},
): ShapeResult<T> {
  const { data, isLoading, isError, lastSyncedAt } = useShape({
    url: ELECTRIC_URL,
    params: {
      table,
      ...(opts.where ? { where: opts.where } : {}),
    },
  });

  // A FAILED FEED IS NOT AN EMPTY ONE, and this is the only place that
  // distinction can be made once for every panel. Reported here rather than
  // rendered here: the hook does not know what a panel wants to show, but
  // it is the one thing every panel passes through, so it is the one place
  // a new panel cannot forget.
  //
  // `unlabelable` vs `transport` is decided from the session's
  // `labeled_tables` — the same list the gateway enforces — so the screen's
  // explanation comes from the authority that made the refusal instead of
  // being inferred from a status code.
  useEffect(() => {
    if (isError) {
      reportShapeError(table, isUnlabelable(table) ? 'unlabelable' : 'transport');
    } else {
      clearShapeError(table);
    }
    return () => clearShapeError(table);
  }, [table, isError]);

  const rows = (data ?? []) as Record<string, any>[];
  return {
    data: rows.map(map),
    isLoading,
    isError,
    lastSyncedAt,
  };
}
