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
import EngagementWatchlist from './components/regional/EngagementWatchlist';
import MunitionsInventory from './components/hq/MunitionsInventory';
import AlertFeed from './components/AlertFeed';
import {
  useFleetAssetsForRegion,
  useAllLogisticsStatus,
  useAllCapabilityState,
  useRegionFleetSummary,
  useRegionTopFactors,
  useRegionWearTrends,
  useTacticalEvents,
  type RegionFleetSummary,
  type RegionTopFactors,
  type RegionWearTrends,
} from './hooks';
import { classifyAsset } from './lib/assetClass';
import {
  aorAssetList,
  severityHeatClass,
  shortSeverity,
} from './lib/fleetAggregates';
import { assetCallsign } from './lib/assetLabel';
import { deployment } from './deployment';

// URL-param shape check. The region picker itself is data-driven (built
// from FOB-declared region_ids + aggregator-observed region_ids); this
// regex only gates the ?region= deep-link param against URL injection.
// Accepts any kebab-case identifier so deployments that name regions
// geographically (e.g. "region-north", "regional-south") work without
// code changes.
const REGION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/** Pick the initial selected region on first mount.
 *
 * Priority order:
 *   1. ?region= URL param (deep-link / shared-link case)
 *   2. First FOB-declared region alphabetically (always available since
 *      loadDeployment() awaits before mount — see main.tsx)
 *   3. null (only when no FOBs are configured — OSS default install)
 *
 * #2 is the key change: pre-fix the picker defaulted from
 * region_fleet_summary which the aggregator populates asynchronously,
 * leaving cold-start with an empty dropdown AND a null-selectedRegion
 * fallback that fetches all assets. Using FOBs means the dropdown lands
 * on a real region from the first paint, no "show everything" window.
 */
/** The region this instance opens on. The tier's configured scope wins over
 *  the URL parameter, for the reason given on MaintainerApp's equivalent:
 *  at a tier node the config is a statement of identity, and a query
 *  parameter must not repoint a tier's UI at a different tier. */
function initialRegion(tierScopeValue?: string | null): string | null {
  if (tierScopeValue) return tierScopeValue;
  const param = new URLSearchParams(window.location.search).get('region');
  if (param && REGION_ID_PATTERN.test(param)) return param;

  const fobRegions = Array.from(new Set(
    deployment().fobs
      .map((f) => f.region_id)
      .filter((r): r is string => !!r && r !== 'region-unspecified'),
  )).sort();
  return fobRegions[0] ?? null;
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

/** The tier's own scope, when this instance is a tier node's UI rather than
 *  the demo shell. Null in the shell, where the operator picks a scope
 *  instead of being one. */
interface TierScopedProps { tierScopeValue?: string | null }

export default function RegionalApp({ tierScopeValue = null }: TierScopedProps) {
  const [link1, setLink1] = useState(true);
  const [isRuleEditorOpen, setIsRuleEditorOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [selectedRegion, setSelectedRegion] = useState<string | null>(
    () => initialRegion(tierScopeValue),
  );

  // Pipeline data — ElectricSQL Shapes.
  const fleetSummary = useRegionFleetSummary();
  const topFactors = useRegionTopFactors();
  const wearTrends = useRegionWearTrends();
  const fleetRaw = useFleetAssetsForRegion(selectedRegion);
  const allCapability = useAllCapabilityState();
  // Filter fired-and-in-flight MUNITION-class rows out of the region-
  // scoped fleet before ANY downstream consumer sees them. Same rule
  // MaintainerApp applies to its picker: a missile in flight isn't a
  // drillable asset -- no CM state, no wear trend, no maintenance
  // affordance -- so an operator-facing "assets in this AOR" list
  // shouldn't include them. In-flight engagement activity surfaces
  // instead through the RegionalSustainmentPosture header IN FLIGHT
  // ticker (kept separate from the hardware count).
  const fleet = useMemo(() => {
    const launcherIds = new Set(allCapability.data.map((c) => c.asset_id));
    const kept = fleetRaw.data.filter((a) => {
      const cls = classifyAsset(a.platform_variant, launcherIds.has(a.asset_id));
      return cls !== 'MUNITION';
    });
    return {
      data: kept,
      isLoading: fleetRaw.isLoading || allCapability.isLoading,
      isError:   fleetRaw.isError   || allCapability.isError,
    };
  }, [fleetRaw.data, fleetRaw.isLoading, fleetRaw.isError,
      allCapability.data, allCapability.isLoading, allCapability.isError]);
  // Per-asset logistics still needed for AorAssetList severity coloring
  // (aggregator outputs are region-level; the picker is per-asset).
  const logistics = useAllLogisticsStatus();
  const events = useTacticalEvents(50);

  // Late-arriving default — safety net for the case where deployment.fobs
  // was empty at mount (OSS default install) and selectedRegion stayed
  // null. If the aggregator later produces a region_id, lock the picker
  // onto that. When FOBs are configured (typical), initialRegion() already
  // resolved selectedRegion at mount and this useEffect is dormant.
  useEffect(() => {
    if (selectedRegion) return;
    const observed = fleetSummary.data
      .map((r) => r.region_id)
      .filter((r): r is string => !!r && r !== 'region-unspecified')
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

  // Pulldown options: union of FOB-declared regions (always available
  // immediately on mount via deployment().fobs) and aggregator-observed
  // regions (might surface region_ids not declared in deployment.json —
  // defensive against config drift). FOB list is the dominant source on
  // cold start; aggregator list catches up asynchronously and is merged
  // in once available.
  const availableRegions = useMemo(() => {
    const fobRegions = deployment().fobs
      .map((f) => f.region_id)
      .filter((r): r is string => !!r && r !== 'region-unspecified');
    const observedRegions = fleetSummary.data
      .map((r) => r.region_id)
      .filter((r): r is string => !!r && r !== 'region-unspecified');
    return Array.from(new Set([...fobRegions, ...observedRegions])).sort();
  }, [fleetSummary.data]);

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

  // Launcher-id set for the region-scoped MunitionsInventory panel.
  // Every LAUNCHER-class asset in the (already region-filtered)
  // hardware fleet contributes its asset_id. MunitionsInventory
  // aggregates stockpile entries whose launcher_asset_id is in this
  // set -- gives a region-scoped rollup by munition type without
  // requiring a new hook.
  const regionLauncherIds = useMemo(() => {
    const launcherIds = new Set(allCapability.data.map((c) => c.asset_id));
    const set = new Set<string>();
    for (const a of fleet.data) {
      if (launcherIds.has(a.asset_id)) set.add(a.asset_id);
    }
    return set;
  }, [fleet.data, allCapability.data]);

  return (
    <div className="font-mono h-full flex flex-col overflow-hidden bg-slate-950 text-slate-200">
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

      <main className="flex-1 grid grid-cols-3 grid-rows-[minmax(0,1fr)] gap-4 p-4 pt-2 overflow-hidden min-h-0">
        <RegionalSustainmentPosture
          link1={link1}
          regionId={selectedRegion}
          selectedAssetId={selectedAssetId}
          onAssetSelect={(id) => setSelectedAssetId(id)}
        />

        {/* Explicit viewport-bounded max-h on the scroll pane: the grid-
            rows + min-h-0 chain empirically did not constrain it to the
            viewport on its own (panels overflowed past the fold with no
            scrollbar). The calc bypasses the chain — 180px = Root dev
            nav bar (h-10 = 40px) + RegionalHeader (~92px) + EdgePulldown
            bar (~37px) with slop. 100vh inside the calc references the
            actual viewport, NOT the role-view's allocated space, so the
            nav bar must be subtracted here even though RegionalApp
            itself doesn't render it. */}
        <div className="col-span-1 flex flex-col gap-4 overflow-hidden min-h-0 max-h-[calc(100vh-180px)]">
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
              {/* Region-scoped munitions rollup by type. Same component
                  as the HQ panel; the launcherIdFilter prop restricts
                  aggregation to launchers in the selected AOR. Regional
                  commander gets available / expended / initial per
                  munition type across their launcher fleet. */}
              <MunitionsInventory
                title={`Munitions Inventory (${(selectedRegion ?? '—').toUpperCase()})`}
                launcherIdFilter={regionLauncherIds}
              />
              <RegionFleetBuckets row={scopedFleetSummary} />
              <EngagementWatchlist regionId={selectedRegion} />
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
