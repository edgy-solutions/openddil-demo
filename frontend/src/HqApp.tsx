// =============================================================================
// HqApp — the HQ view (enterprise fleet analytics)
// =============================================================================
// Phase 6c.1 rewrite. Was client-side group-by over the global flat pool
// (cmComplianceSummary / logisticsSeveritySummary / wearTrendRollup).
// Now sums faust-regional's per-region aggregates (region_fleet_summary /
// region_top_factors / region_wear_trends) across all regions to produce
// the theater-level rollup. With 2 regions, sum-of-regions is right-sized
// for client-side aggregation — see follow-up #12 for the at-scale
// (10+ regions) trade-off and three named mitigations.
//
// Semantic shift worth naming: pre-§C.1 FleetReadiness showed a 2-column
// "CM status / Logistics severity" split (CM-specialist's question +
// logistics-specialist's question). Post-§C.1 it shows the unified
// severity buckets (nominal/degraded/critical/non_operational) the
// aggregator computes as WORST-of(logistics, cm). This matches the
// theater commander's "how many assets in what condition" question
// rather than the two-specialty-split. The disambiguated specialty
// views still live in ConfigurationPosture (CM) and EdgeAttribution
// (per-edge); we lost no information, we re-framed the headline.
//
// Phase 4c.5: the WAN-cut demo is REAL (toxiproxy hq-link, edge-buffer
// monitor, freeze overlay — unchanged in §C.1).
import { useState, useMemo } from 'react';
import HqHeader from './components/hq/HqHeader';
import TheaterReadinessPosture from './components/hq/TheaterReadinessPosture';
import HqDigitalTwin from './components/hq/HqDigitalTwin';
import HqWorkOrders from './components/hq/HqWorkOrders';
import EdgeAttribution from './components/hq/EdgeAttribution';
import RegionFleetSummary from './components/hq/RegionFleetSummary';
import { AlertOctagon } from 'lucide-react';
import {
  useAllCmState,
  useFleetAssets,
  useEdgeBuffer,
  useRegionFleetSummary,
  useRegionTopFactors,
  useRegionWearTrends,
  type RegionFactor,
  type ComponentWearTrend,
} from './hooks';
import {
  mwoComplianceByFamily,
  baselineDistribution,
} from './lib/fleetAggregates';

// Top-N HQ size matches per-region size (locked: tightening D). A theater
// commander wants fewer summarized items, not more; configurable later if
// needed.
const HQ_TOP_FACTORS_N = 10;

// --- HQ-level region-merge helpers (per recipe decision 6) -----------------
//
// These collapse N per-region aggregator rows into a single theater-level
// view. They're inline (not in fleetAggregates.ts) because they're
// tightly coupled to the new hook shapes and to HQ's display semantics.

function sumFleetBuckets(
  rows: ReturnType<typeof useRegionFleetSummary>['data'],
): { nominal: number; degraded: number; critical: number; non_operational: number; asset_count: number } {
  // Column-wise sum across regions. Trivial.
  return rows.reduce(
    (acc, r) => ({
      nominal:         acc.nominal + r.nominal,
      degraded:        acc.degraded + r.degraded,
      critical:        acc.critical + r.critical,
      non_operational: acc.non_operational + r.non_operational,
      asset_count:     acc.asset_count + r.asset_count,
    }),
    { nominal: 0, degraded: 0, critical: 0, non_operational: 0, asset_count: 0 },
  );
}

function mergeTopFactors(
  rows: ReturnType<typeof useRegionTopFactors>['data'],
  n: number,
): RegionFactor[] {
  // Merge by factor_id, sum counts across regions, merge severity_breakdown
  // additively. Sort DESC by merged count, take top-N.
  const merged = new Map<string, RegionFactor>();
  for (const row of rows) {
    for (const f of row.factors) {
      const existing = merged.get(f.factor_id);
      if (existing) {
        existing.count += f.count;
        for (const [sev, c] of Object.entries(f.severity_breakdown)) {
          existing.severity_breakdown[sev] = (existing.severity_breakdown[sev] ?? 0) + c;
        }
      } else {
        merged.set(f.factor_id, {
          factor_id: f.factor_id,
          count: f.count,
          severity_breakdown: { ...f.severity_breakdown },
        });
      }
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function mergeWearTrends(
  rows: ReturnType<typeof useRegionWearTrends>['data'],
): ComponentWearTrend[] {
  // Merge by (component_id, unit) per the mixed-unit handling rule (Q3).
  // mean_rul_remaining is a weighted mean — each region's contribution
  // weighted by its asset_count, so a region with 10 assets contributes
  // more to the theater mean than a region with 1. Never collapses across
  // units; the same component_id appears multiple times if regions
  // reported in different units.
  type Accum = { sum_weighted_rul: number; sum_assets: number };
  const acc = new Map<string, Accum>();
  for (const row of rows) {
    for (const c of row.components) {
      const key = `${c.component_id}|${c.unit}`;
      const existing = acc.get(key);
      if (existing) {
        existing.sum_weighted_rul += c.mean_rul_remaining * c.asset_count;
        existing.sum_assets += c.asset_count;
      } else {
        acc.set(key, {
          sum_weighted_rul: c.mean_rul_remaining * c.asset_count,
          sum_assets: c.asset_count,
        });
      }
    }
  }
  return Array.from(acc.entries()).map(([key, v]) => {
    const [component_id, unit] = key.split('|');
    return {
      component_id,
      unit,
      mean_rul_remaining: v.sum_assets > 0 ? v.sum_weighted_rul / v.sum_assets : 0,
      asset_count: v.sum_assets,
    };
  });
}

// --- panels (inline — HQ-specific rollup displays) -------------------------

function FleetReadiness({
  fleetSummary,
}: {
  fleetSummary: ReturnType<typeof useRegionFleetSummary>['data'];
}) {
  const totals = useMemo(() => sumFleetBuckets(fleetSummary), [fleetSummary]);
  const empty = fleetSummary.length === 0;
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Fleet-Wide Readiness (theater)
      </h2>
      {empty ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no region rollup observed yet
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="flex justify-between">
            <span className="text-emerald-300">nominal</span>
            <span className="text-slate-200 font-bold">{totals.nominal}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-amber-300">degraded</span>
            <span className="text-slate-200 font-bold">{totals.degraded}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-orange-300">critical</span>
            <span className="text-slate-200 font-bold">{totals.critical}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-red-300">non-operational</span>
            <span className="text-slate-200 font-bold">{totals.non_operational}</span>
          </div>
          <div className="flex justify-between col-span-2 border-t border-slate-800 pt-1">
            <span className="text-slate-400">total assets</span>
            <span className="text-slate-200 font-bold">{totals.asset_count}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TopFactorsTheater({
  topFactors,
}: {
  topFactors: ReturnType<typeof useRegionTopFactors>['data'];
}) {
  const merged = useMemo(
    () => mergeTopFactors(topFactors, HQ_TOP_FACTORS_N),
    [topFactors],
  );
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Top Constraining Factors (theater)
      </h2>
      {merged.length === 0 ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no factors observed yet
        </div>
      ) : (
        <div className="space-y-1">
          {merged.map((f) => (
            <div key={f.factor_id} className="flex items-center justify-between text-xs">
              <span className="text-slate-300">{f.factor_id}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm border border-slate-700 text-slate-300">
                {f.count} asset{f.count === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurationPosture({
  cm, fleet,
}: {
  cm: ReturnType<typeof useAllCmState>['data'];
  fleet: ReturnType<typeof useFleetAssets>['data'];
}) {
  const mwo = useMemo(() => mwoComplianceByFamily(cm, fleet), [cm, fleet]);
  const baselines = useMemo(() => baselineDistribution(cm), [cm]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Configuration Posture</h2>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">MWO/TCTO compliance by family</div>
      {mwo.length === 0 && <div className="text-xs text-slate-500 mb-2">—</div>}
      {mwo.map((m) => (
        <div key={m.family} className="flex items-center justify-between text-xs mb-0.5">
          <span className="text-slate-400">{m.family}</span>
          <span className="flex items-center gap-2">
            <span className="text-slate-500 text-[10px]">{m.compliant}/{m.total}</span>
            <span className={`font-bold ${m.rate >= 0.9 ? 'text-emerald-400' : m.rate >= 0.5 ? 'text-amber-400' : 'text-rose-400'}`}>
              {Math.round(m.rate * 100)}%
            </span>
          </span>
        </div>
      ))}
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-2 mb-1">Baseline distribution</div>
      {baselines.length === 0 && <div className="text-xs text-slate-500">—</div>}
      {baselines.map((b) => (
        <div key={b.baseline_id} className="flex justify-between text-xs">
          <span className="text-slate-400 truncate mr-2">{b.baseline_id}</span>
          <span className="text-slate-200 font-bold">{b.count}</span>
        </div>
      ))}
    </div>
  );
}

function WearTrendsTheater({
  wearTrends,
}: {
  wearTrends: ReturnType<typeof useRegionWearTrends>['data'];
}) {
  const merged = useMemo(() => mergeWearTrends(wearTrends), [wearTrends]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Fleet Wear Trends (theater)
      </h2>
      {merged.length === 0 ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no wear components observed yet
        </div>
      ) : (
        <div className="space-y-1 text-xs font-mono">
          {merged.map((c) => (
            <div
              key={`${c.component_id}|${c.unit}`}
              className="flex items-center justify-between"
            >
              <span className="text-slate-300">
                {c.component_id}
                {c.unit ? <span className="text-slate-500"> ({c.unit})</span> : null}
              </span>
              <span className="text-slate-200">
                mean RUL {c.mean_rul_remaining.toFixed(1)}
                <span className="text-slate-500"> · {c.asset_count} asset{c.asset_count === 1 ? '' : 's'}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HqApp() {
  const [wanActive, setWanActive] = useState(true);

  // Pipeline data — ElectricSQL Shapes. cm + fleet still used by
  // ConfigurationPosture (MWO compliance by family, baseline distribution)
  // — the per-platform-family slice is NOT in the rolled-up topics.
  const cm = useAllCmState();
  const fleet = useFleetAssets();
  const edge = useEdgeBuffer();

  // Phase 6c.1: theater-level rollup sources.
  const regionFleet = useRegionFleetSummary();
  const regionTopFactors = useRegionTopFactors();
  const regionWearTrends = useRegionWearTrends();

  const severed = edge.status ? edge.status.hq_link_severed : !wanActive;

  const toggleWan = async (active: boolean) => {
    setWanActive(active);
    try {
      await fetch('/proxies/hq-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: active }),
      });
    } catch (err) {
      console.error('Toxiproxy Error:', err);
    }
  };

  return (
    <div className={`font-mono h-screen flex flex-col overflow-hidden transition-colors duration-500 ${severed ? 'freeze-active' : ''}`}>
      <HqHeader wanActive={wanActive} setWanActive={toggleWan} />

      {severed && (
        <div className="absolute inset-0 z-40 pointer-events-none flex flex-col items-center justify-center pt-20">
          <div className="scanlines absolute inset-0 pointer-events-none z-50 bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,0)_50%,rgba(0,0,0,0.2)_50%,rgba(0,0,0,0.2))] bg-[length:100%_4px]"></div>
          <div className="bg-rose-950/90 border-2 border-rose-500 px-16 py-8 flex flex-col items-center backdrop-blur-md shadow-[0_0_100px_rgba(225,29,72,0.4)] z-50">
            <AlertOctagon className="w-16 h-16 text-rose-500 mb-4 animate-pulse" />
            <h1 className="font-orbitron animate-[pulse-red_2s_infinite] text-5xl font-black text-rose-500 tracking-widest mb-2">SYSTEM FREEZE</h1>
            <p className="text-rose-300 font-mono tracking-widest text-lg bg-rose-900/50 px-4 py-1 border border-rose-500/50">WAN UPLINK SEVERED • DISPLAYING STALE DATA</p>
          </div>
        </div>
      )}

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden relative z-0">
        <TheaterReadinessPosture wanActive={!severed} linksUp={severed ? 0 : 1} linksDown={severed ? 1 : 0} />

        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <EdgeAttribution />
          <RegionFleetSummary />
          <FleetReadiness fleetSummary={regionFleet.data} />
          <TopFactorsTheater topFactors={regionTopFactors.data} />
          <ConfigurationPosture cm={cm.data} fleet={fleet.data} />
          <WearTrendsTheater wearTrends={regionWearTrends.data} />
          <HqDigitalTwin wanActive={!severed} />
          <HqWorkOrders wanActive={!severed} />
        </div>
      </main>
    </div>
  );
}
