// usePartsAvailability -- parts stock figures per site (rows exist only at HQ).
// Source: parts_availability. Any figure may be NULL, which means unknown,
// never zero; the mapper keeps null as null.
import { num, parseTextArray, useTableShape, sqlLiteral, type ShapeResult } from './electric';

export interface PartsAvailability {
  site: string;
  partRef: string;
  onHand: number | null;
  leadTimeDays: number | null;
  nearestSiteWithStock: string | null;
  nearestOnHand: number | null;
  source: string | null;
  observedAt: string | null;
  updatedAt: string | null;
  /** Releasability labels as stored (ADR-0029); null when unlabelled. */
  originatorNation: string | null;
  releasableTo: string[] | null;
}

function nullableStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

export function mapPartsAvailability(row: Record<string, unknown>): PartsAvailability {
  return {
    site: String(row.site ?? ''),
    partRef: String(row.part_ref ?? ''),
    onHand: nullableNum(row.on_hand),
    leadTimeDays: nullableNum(row.lead_time_days),
    nearestSiteWithStock: nullableStr(row.nearest_site_with_stock),
    nearestOnHand: nullableNum(row.nearest_on_hand),
    source: nullableStr(row.source),
    observedAt: nullableStr(row.observed_at),
    updatedAt: nullableStr(row.updated_at),
    originatorNation: row.originator_nation == null || row.originator_nation === '' ? null : String(row.originator_nation),
    releasableTo: parseTextArray(row.releasable_to),
  };
}

/** Parts availability rows for the given sites. */
export function usePartsAvailability(sites: string[]): ShapeResult<PartsAvailability> {
  const ids = [...new Set(sites)].sort();
  return useTableShape('parts_availability', mapPartsAvailability, {
    where: `site IN (${(ids.length ? ids : ['']).map(sqlLiteral).join(', ')})`,
  });
}
