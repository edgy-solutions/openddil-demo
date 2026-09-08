// useRegionFleetSummary — Phase 6b §B observable checkpoint hook.
// Reads region_fleet_summary, populated by the projector's
// region_fleet_summary handler from faust-regional's RegionFleetSummary
// emits, and SUMS the partials this subject is allowed to see.
//
// PARTIALS, NOT ONE ROW PER REGION. The aggregator emits one row per
// releasability class — {ATL}, {BDR}, {ATL,BDR} — because one row cannot
// express the access rule. Measured on region-east: fourteen contributors in
// three classes whose intersection is empty, so a single composed row was
// releasable to nobody, the liaison included, despite the liaison being
// entitled to every one of them.
//
// Each partial is an ordinary labelled row, so the PEP's overlap predicate
// filters them with no aggregate-specific logic. What arrives here is
// therefore already "the partials this subject may see", and summing them
// gives a total that contains nothing the subject cannot see:
//
//   liaison (ATL,BDR)  3 partials  -> 14
//   Ada (ATL)          2 partials  ->  8
//   user-b (BDR)       2 partials  ->  7
//
// COUNTS SUM EXACTLY because the classes partition the contributors — every
// asset is in exactly one class. That is NOT true of the other two rollups
// (see useRegionTopFactors / useRegionWearTrends, which merge lossily and
// say so).
import { num, useTableShape, type ShapeResult } from './electric';

export interface RegionFleetSummary {
  region_id: string;
  nominal: number;
  degraded: number;
  critical: number;
  non_operational: number;
  asset_count: number;
  observed_at: string | null;
  /** How many releasability-class partials this subject could see. */
  partial_count: number;
}

interface RawPartial extends Omit<RegionFleetSummary, 'partial_count'> {
  releasability_class: string;
}

function mapRow(row: Record<string, any>): RawPartial {
  return {
    region_id: row.region_id,
    releasability_class: row.releasability_class ?? '',
    nominal: num(row.nominal),
    degraded: num(row.degraded),
    critical: num(row.critical),
    non_operational: num(row.non_operational),
    asset_count: num(row.asset_count),
    observed_at: row.observed_at ?? null,
  };
}

export function useRegionFleetSummary(): ShapeResult<RegionFleetSummary> {
  const raw = useTableShape<RawPartial>('region_fleet_summary', mapRow);

  const byRegion = new Map<string, RegionFleetSummary>();
  for (const p of raw.data) {
    const acc = byRegion.get(p.region_id);
    if (!acc) {
      byRegion.set(p.region_id, {
        region_id: p.region_id,
        nominal: p.nominal,
        degraded: p.degraded,
        critical: p.critical,
        non_operational: p.non_operational,
        asset_count: p.asset_count,
        observed_at: p.observed_at,
        partial_count: 1,
      });
      continue;
    }
    acc.nominal += p.nominal;
    acc.degraded += p.degraded;
    acc.critical += p.critical;
    acc.non_operational += p.non_operational;
    acc.asset_count += p.asset_count;
    acc.partial_count += 1;
    // OLDEST wins, deliberately. A region's summary is only as current as its
    // stalest partial: if the {BDR} partial stopped updating an hour ago, a
    // total that advertises the {ATL} partial's timestamp claims a freshness
    // the number does not have. Same reason two-hop freshness carries both
    // ages instead of fusing them.
    if (p.observed_at && (!acc.observed_at || p.observed_at < acc.observed_at)) {
      acc.observed_at = p.observed_at;
    }
  }

  return { ...raw, data: Array.from(byRegion.values()) };
}
