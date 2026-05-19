// =============================================================================
// RegionalApp — the regional view (AOR fleet rollup)
// =============================================================================
// Phase 6c.1 rewrite. Was reading the global flat-pool via useAllLogistics-
// Status / useAllCmState and grouping client-side via fleetAggregates.ts
// (topConstrainingFactors, cmComplianceSummary). Now reads the per-region
// rolled-up topics that faust-regional emits (region_fleet_summary,
// region_top_factors, region_wear_trends), scoped to a pulldown-selected
// region.
//
// Pulldown is the dev/demo mechanism for what production auth-context
// will do — a regional officer is fixed-to-their-region by their role,
// not by URL param. Pulldown writes ?region=region-NN so reloads /
// shared links land on the same scope. No animated transition on this
// pulldown (regional pulldown has no production analog; the maintainer
// pulldown's "FOB transport" animation is owned by §C.3 — see follow-up
// #15 for the asymmetry rationale).
//
// AorAssetList stays per-asset (the picker needs per-asset granularity;
// aggregator outputs are region-level). Region-scoped via
// useFleetAssetsForRegion.
//
// The 3D RegionalSustainmentPosture remains DEMO_MOCK (synthetic theater
// positions — real geo projection deferred per ADR-0017). Not in §C.1
// scope.
import { useState, useEffect, useMemo } from 'react';
import RegionalHeader from './components/regional/RegionalHeader';
import RegionalSustainmentPosture from './components/regional/RegionalSustainmentPosture';
import WorkOrders from './components/regional/WorkOrders';
import TacticalRuleBuilder from './components/regional/TacticalRuleBuilder';
import AssetDeepDive from './components/regional/AssetDeepDive';
import AlertFeed from './components/AlertFeed';
import {
  useFleetAssetsForRegion,
  useAllLogisticsStatus,
  useRegionFleetSummary,
  useRegionTopFactors,
  useRegionWearTrends,
  useTacticalEvents,
  type RegionFleetSummary,
  type RegionTopFactors,
  type RegionWearTrends,
} from './hooks';
import {
  aorAssetList,
  severityHeatClass,
  shortSeverity,
} from './lib/fleetAggregates';
import { assetCallsign } from './lib/assetLabel';

const VALID_REGIONS = ['region-east', 'region-west'];

function initialRegion(): string | null {
  const param = new URLSearchParams(window.location.search).get('region');
  if (param && VALID_REGIONS.includes(param)) return param;
  return null;
}

// --- panels ----------------------------------------------------------------

function RegionPulldown({
  available, selected, onSelect,
}: {
  available: string[];
  selected: string | null;
  onSelect: (regionId: string) => void;
}) {
  // Visually unobtrusive — dev infrastructure, not narrative payoff. The
  // maintainer pulldown (§C.2) will be more prominent because it IS the
  // demo payoff (FOB transport). Asymmetry documented in follow-up #15.
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">
        Region scope
      </span>
      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        className="bg-slate-800 border border-slate-700 text-slate-200 text-[11px] rounded px-2 py-1"
        disabled={available.length === 0}
      >
        {available.length === 0 ? (
          <option value="">no regions observed yet</option>
        ) : (
          available.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))
        )}
      </select>
    </div>
  );
}

function AorAssetList({
  fleet, logistics, selectedId, onSelect,
}: {
  fleet: ReturnType<typeof useFleetAssetsForRegion>['data'];
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => aorAssetList(fleet, logistics), [fleet, logistics]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        AOR Assets ({rows.length})
      </h2>
      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
        {rows.length === 0 && (
          <div className="text-xs text-slate-500">
            No assets in this region.
          </div>
        )}
        {rows.map((r) => {
          const callsign = assetCallsign(r);
          return (
            <button
              key={r.asset_id}
              onClick={() => onSelect(r.asset_id)}
              title={r.asset_id}
              className={`w-full flex items-center justify-between gap-2 text-left text-xs px-2 py-1 border rounded-sm transition-colors ${severityHeatClass(r.severity)} ${selectedId === r.asset_id ? 'ring-1 ring-cyan-400' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.asset_id}</span>
                {callsign && <span className="block truncate opacity-60">{callsign}</span>}
              </span>
              <span className="text-[9px] font-bold shrink-0">{shortSeverity(r.severity)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RegionFleetBuckets({ row }: { row: RegionFleetSummary | undefined }) {
  // Replaces the old CmComplianceSummary panel. Severity buckets here are
  // the WORST-of(logistics, cm) combined buckets the aggregator computes
  // — semantic shift from the pre-§C.1 cm-only buckets, but matches the
  // regional commander's "how many assets in what condition" question
  // rather than "how many in each cm discrepancy level" (CM-specialist's
  // question; not the regional officer's).
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Fleet Severity (region)
      </h2>
      {!row ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no region rollup observed yet
        </div>
      ) : (
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-emerald-300">nominal</span>
            <span className="text-slate-200 font-bold">{row.nominal}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-amber-300">degraded</span>
            <span className="text-slate-200 font-bold">{row.degraded}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-orange-300">critical</span>
            <span className="text-slate-200 font-bold">{row.critical}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-red-300">non-operational</span>
            <span className="text-slate-200 font-bold">{row.non_operational}</span>
          </div>
          <div className="flex justify-between border-t border-slate-800 pt-1">
            <span className="text-slate-400">assets</span>
            <span className="text-slate-200 font-bold">{row.asset_count}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TopFactors({ row }: { row: RegionTopFactors | undefined }) {
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Top Constraining Factors (region)
      </h2>
      {!row || row.factors.length === 0 ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no factors observed yet
        </div>
      ) : (
        <div className="space-y-1">
          {row.factors.map((f) => (
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

function WearTrends({ row }: { row: RegionWearTrends | undefined }) {
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
        Wear Trends (region)
      </h2>
      {!row || row.components.length === 0 ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no wear components observed yet
        </div>
      ) : (
        <div className="space-y-1 text-xs font-mono">
          {row.components.map((c) => (
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

// --- app -------------------------------------------------------------------

export default function RegionalApp() {
  const [link1, setLink1] = useState(true);
  const [isRuleEditorOpen, setIsRuleEditorOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [selectedRegion, setSelectedRegion] = useState<string | null>(initialRegion);

  // Pipeline data — ElectricSQL Shapes.
  const fleetSummary = useRegionFleetSummary();
  const topFactors = useRegionTopFactors();
  const wearTrends = useRegionWearTrends();
  const fleet = useFleetAssetsForRegion(selectedRegion);
  // Per-asset logistics still needed for AorAssetList severity coloring
  // (aggregator outputs are region-level; the picker is per-asset).
  const logistics = useAllLogisticsStatus();
  const events = useTacticalEvents(50);

  // Default region on first load (decision 2): first region from the
  // aggregator's observed list, sorted alphabetically. Cold-start tolerant:
  // if no regions observed yet, stays null and panels show their cold
  // states.
  useEffect(() => {
    if (selectedRegion) return;
    const observed = fleetSummary.data
      .map((r) => r.region_id)
      .filter((r) => VALID_REGIONS.includes(r))
      .sort();
    if (observed.length > 0) setSelectedRegion(observed[0]);
  }, [fleetSummary.data, selectedRegion]);

  // Keep ?region= in sync so reload / shared link lands on the same scope.
  useEffect(() => {
    if (!selectedRegion) return;
    const url = new URL(window.location.href);
    url.searchParams.set('region', selectedRegion);
    window.history.replaceState(null, '', url);
  }, [selectedRegion]);

  // DDIL hq-link sever/restore — same as MaintainerApp.
  useEffect(() => {
    fetch('/proxies/hq-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: link1 }),
    }).catch((e) => console.error('Toxiproxy error', e));
  }, [link1]);

  const filteredEvents = useMemo(() => {
    if (severityFilter === 'ALL') return events.data;
    return events.data.filter((e) => (e.severity ?? '').toUpperCase().includes(severityFilter));
  }, [events.data, severityFilter]);

  // Pulldown options come from what the aggregator has actually observed.
  const availableRegions = useMemo(
    () => fleetSummary.data
      .map((r) => r.region_id)
      .filter((r) => VALID_REGIONS.includes(r))
      .sort(),
    [fleetSummary.data],
  );

  // Per-region rows (extracted once, fed to panels).
  const scopedFleetSummary = useMemo(
    () => fleetSummary.data.find((r) => r.region_id === selectedRegion),
    [fleetSummary.data, selectedRegion],
  );
  const scopedTopFactors = useMemo(
    () => topFactors.data.find((r) => r.region_id === selectedRegion),
    [topFactors.data, selectedRegion],
  );
  const scopedWearTrends = useMemo(
    () => wearTrends.data.find((r) => r.region_id === selectedRegion),
    [wearTrends.data, selectedRegion],
  );

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <RegionalHeader
        link1={link1} setLink1={setLink1}
        setIsRuleEditorOpen={setIsRuleEditorOpen}
      />

      {/* Pulldown — dev/demo mechanism. Visually unobtrusive per the
          regional-vs-maintainer asymmetry; see follow-up #15. */}
      <div className="px-4 py-1 border-b border-slate-800 bg-slate-900/50">
        <RegionPulldown
          available={availableRegions}
          selected={selectedRegion}
          onSelect={setSelectedRegion}
        />
      </div>

      <main className="flex-1 grid grid-cols-3 grid-rows-[minmax(0,1fr)] gap-4 p-4 pt-2 overflow-hidden">
        <RegionalSustainmentPosture
          link1={link1}
          selectedAssetId={selectedAssetId}
          onAssetSelect={(id) => setSelectedAssetId(id)}
        />

        <div className="col-span-1 flex flex-col gap-4 overflow-hidden min-h-0">
          {selectedAssetId ? (
            <AssetDeepDive assetId={selectedAssetId} onClose={() => setSelectedAssetId(null)} />
          ) : (
            <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-4 min-h-0">
              <AorAssetList
                fleet={fleet.data}
                logistics={logistics.data}
                selectedId={selectedAssetId}
                onSelect={setSelectedAssetId}
              />
              <RegionFleetBuckets row={scopedFleetSummary} />
              <TopFactors row={scopedTopFactors} />
              <WearTrends row={scopedWearTrends} />
              <WorkOrders />
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">Severity filter</span>
                  <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 text-slate-300 text-[10px] rounded px-1 py-0.5"
                  >
                    <option value="ALL">All</option>
                    <option value="CRITICAL">Critical</option>
                    <option value="DEGRADED">Degraded</option>
                    <option value="MAJOR">Major</option>
                  </select>
                </div>
                <AlertFeed events={filteredEvents} isLoading={events.isLoading} />
              </div>
            </div>
          )}
        </div>
      </main>

      <TacticalRuleBuilder isOpen={isRuleEditorOpen} onClose={() => setIsRuleEditorOpen(false)} />
    </div>
  );
}
