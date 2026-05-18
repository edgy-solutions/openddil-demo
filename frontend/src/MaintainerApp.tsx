// =============================================================================
// MaintainerApp — the maintainer view (per-asset detail)
// =============================================================================
// Phase 4c. Renamed from App.tsx (the Phase 4b "edge view") and expanded
// into the maintainer-focused per-asset detail view: a fleet picker plus,
// for the selected asset, an identity strip, a CM state card, a logistics
// status card, the sustainment telemetry panel, an asset-filtered event
// feed, and the 3D schematic (SensorArrayView for RADAR-class via
// DiagnosticCanvas, VehicleClassSchematic otherwise).
//
// All pipeline data comes from ElectricSQL Shapes (./hooks). Phase 4c.5:
// the link toggle now severs/restores the REAL toxiproxy hq-link proxy,
// and the edge-buffer counter (in Header) reads real bridge-group lag via
// useEdgeBuffer — no more client-side simulation.
import { useState, useEffect, useMemo } from 'react';
import Header from './components/Header';
import DiagnosticCanvas from './components/DiagnosticCanvas';
import LocalFleetRadar from './components/LocalFleetRadar';
import TelemetryCharts from './components/TelemetryCharts';
import AlertFeed from './components/AlertFeed';
import Inventory from './components/Inventory';
import CmStateCard from './components/CmStateCard';
import LogisticsStatusCard from './components/LogisticsStatusCard';
import {
  useFleetAssets,
  useFleetAssetsForEdge,
  useTelemetryLatest,
  useCmState,
  useLogisticsStatus,
  useTacticalEvents,
} from './hooks';
import { platformClass } from './config/platformChartConfig';

// Phase 6c.2: edge-scope mechanism (pulldown + ?edge= URL param). The
// available-edges list is derived from useFleetAssets().data distinct
// edge_ids (symmetric with §C.1's region-from-summary pattern). The
// regex below pins the URL-param shape so a malformed value (?edge=foo)
// is rejected rather than passed to the Shape API as a where-clause.
const EDGE_ID_PATTERN = /^edge-[a-zA-Z0-9-]+$/;
// Asset-id deep-link pattern. Conservative — covers the dis:1:1:NNNN
// shape the demo uses; expand if other producers introduce other
// asset-id shapes.
const ASSET_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;

function initialEdge(): string | null {
  const param = new URLSearchParams(window.location.search).get('edge');
  if (param && EDGE_ID_PATTERN.test(param)) return param;
  return null;
}

function initialAssetParam(): string | null {
  const param = new URLSearchParams(window.location.search).get('asset');
  if (param && ASSET_ID_PATTERN.test(param)) return param;
  return null;
}

function formatSeen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { hour12: false });
}

function MaintainerApp() {
  // link1 = the DDIL link toggle (severs/restores the real hq-link proxy).
  const [link1, setLink1] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [clock, setClock] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  // Phase 6c.2: edge scope. Initial value comes from ?edge= URL param if
  // present and well-formed; otherwise resolved from the observed-edges
  // list (first alphabetically) once the unfiltered fleet shape returns.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(initialEdge);

  // Pending deep-link from ?asset= URL param — used at most once on
  // first load. We hold it as state (not a ref) so it stays visible in
  // React DevTools when debugging deep-link issues. Cleared after first
  // successful application OR after we've determined the asset isn't in
  // the scoped edge (case 2 of tightening A).
  const [pendingDeepLinkAsset, setPendingDeepLinkAsset] = useState<string | null>(initialAssetParam);

  // Pipeline data — ElectricSQL Shapes, no polling.
  // Unfiltered fleet shape — sourced for the EdgePulldown's
  // available-edges list. Cheap (same shape every panel-tier consumer
  // already subscribes to elsewhere) and stays current as new edges
  // come online.
  const fleetAll = useFleetAssets();
  // Edge-scoped fleet — drives the Header's asset picker. When
  // selectedEdge is null (URL had no ?edge= AND default not yet
  // resolved), falls back to the unfiltered shape so the picker isn't
  // empty during the brief cold-start window.
  const fleetScoped = useFleetAssetsForEdge(selectedEdge);
  const fleet = selectedEdge ? fleetScoped : fleetAll;

  const telemetry = useTelemetryLatest(selectedAssetId);
  const cm = useCmState(selectedAssetId);
  const logistics = useLogisticsStatus(selectedAssetId);
  // Maintainer view: recent events filtered to the selected asset.
  const events = useTacticalEvents(10, selectedAssetId);

  // Available edges for the pulldown — distinct edge_ids actually
  // observed in the pipeline. Sorted alphabetically. Symmetric with
  // RegionalApp's region-from-summary pattern.
  const availableEdges = useMemo(
    () => Array.from(new Set(
      fleetAll.data
        .map((a) => a.edge_id)
        .filter((e): e is string => !!e && e !== 'edge-unspecified'),
    )).sort(),
    [fleetAll.data],
  );

  // Default-on-first-load for the edge pulldown: first observed edge
  // alphabetically, if no ?edge= URL param resolved one. Cold-start
  // tolerant: if no edges observed yet, stays null and pulldown shows
  // its "no edges observed yet" state.
  useEffect(() => {
    if (selectedEdge) return;
    if (availableEdges.length === 0) return;
    setSelectedEdge(availableEdges[0]);
  }, [availableEdges, selectedEdge]);

  // Keep ?edge= in sync so reload / shared link lands on the same scope.
  useEffect(() => {
    if (!selectedEdge) return;
    const url = new URL(window.location.href);
    url.searchParams.set('edge', selectedEdge);
    window.history.replaceState(null, '', url);
  }, [selectedEdge]);

  // Keep ?asset= in sync so deep links to (edge, asset) pairs are
  // shareable. Cleared when no asset is selected so the URL doesn't
  // carry a stale value.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedAssetId) url.searchParams.set('asset', selectedAssetId);
    else url.searchParams.delete('asset');
    window.history.replaceState(null, '', url);
  }, [selectedAssetId]);

  // Asset selection logic — Phase 6c.2 three-case behavior for the
  // ?edge= + ?asset= URL-param combination (tightening A):
  //
  //   1. Both params present AND ?asset= is in the scoped edge's
  //      fleet → use that asset (honor the deep link).
  //   2. Both params present BUT ?asset= is NOT in the scoped edge →
  //      fall back to auto-pick first asset of the edge (URL is stale
  //      or wrong; deep-link cleared).
  //   3. Only ?edge= present (or no URL params) → auto-pick first
  //      asset of the scoped edge.
  //
  // After first application, pendingDeepLinkAsset is cleared and this
  // collapses to the normal "auto-pick first; re-home on fleet change"
  // logic.
  //
  // ON "FIRST ASSET": fleet.data[0] is whichever asset the ElectricSQL
  // Shape emits first — Shape-implementation order, NOT alphabetical
  // or last_seen-sorted. Surfaced during §C.2 verification when the
  // playbook predicted 2259 (alphabetical) but the actual fallback
  // resolved to 2820 (Shape emit order). This is fine for the fallback
  // purpose (any valid edge asset works) but future code that needs a
  // stable / deterministic first-asset should `.sort()` explicitly
  // before reading [0].
  useEffect(() => {
    if (fleet.data.length === 0) return;

    // Case 1 / 2: pending deep-link asset to resolve.
    if (pendingDeepLinkAsset) {
      const found = fleet.data.some((a) => a.asset_id === pendingDeepLinkAsset);
      if (found) {
        setSelectedAssetId(pendingDeepLinkAsset);  // case 1 — honor link
      } else {
        setSelectedAssetId(fleet.data[0].asset_id);  // case 2 — fallback
      }
      setPendingDeepLinkAsset(null);
      return;
    }

    // Case 3 + ordinary re-home: default to first, re-home if current
    // selection dropped out of the (possibly newly-scoped) fleet.
    const stillPresent = fleet.data.some((a) => a.asset_id === selectedAssetId);
    if (!selectedAssetId || !stillPresent) {
      setSelectedAssetId(fleet.data[0].asset_id);
    }
  }, [fleet.data, selectedAssetId, pendingDeepLinkAsset]);

  // Explicit reset on pulldown change — clearing selectedAssetId here
  // makes the re-home effect above fire deterministically rather than
  // relying on stillPresent edge cases (e.g., an asset_id that happens
  // to exist in both edges, though that shouldn't be possible with the
  // current pipeline shape, defensive against future schema changes).
  const onSelectEdge = (edgeId: string) => {
    if (edgeId === selectedEdge) return;
    setSelectedAssetId('');
    setSelectedEdge(edgeId);
  };

  // DDIL uplink sever/restore. Phase 4c.5: the link toggle DISABLES /
  // ENABLES the real toxiproxy hq-link proxy — toxiproxy then closes all
  // connections and refuses new ones, so the edge-hq-bridge genuinely
  // cannot reach redpanda-hq, stops committing `bridge-group` offsets,
  // and the real edge buffer climbs. (A timeout toxic would only delay
  // the ack and still let the produce through — it would not buffer.)
  useEffect(() => {
    fetch('/proxies/hq-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: link1 }),
    }).catch((e) => console.error('Toxiproxy error', e));
  }, [link1]);

  // link1 drives the degraded UI state.
  useEffect(() => {
    if (!link1 && !degraded) setDegraded(true);
    else if (link1 && degraded) setDegraded(false);
  }, [link1, degraded]);

  // Wall clock. The edge buffer is no longer simulated here — Header reads
  // the real bridge-group lag via useEdgeBuffer.
  useEffect(() => {
    const interval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const selectedAsset = fleet.data.find((a) => a.asset_id === selectedAssetId) ?? null;
  const tel = telemetry.data[0] ?? null;
  const cmState = cm.data[0] ?? null;
  const logiState = logistics.data[0] ?? null;
  const variant = selectedAsset?.platform_variant ?? null;
  // DEV_ONLY / DEMO_OVERRIDE — `?force=radar` URL param routes
  // DiagnosticCanvas to SensorArrayView regardless of the selected
  // asset's variant. Visual-parity verification hook while no real
  // RADAR-class platform_variant exists in the live pipeline. Gated by
  // import.meta.env.DEV so it is COMPILED OUT of production builds —
  // stakeholders cannot force-route platforms in prod.
  // DELETE this entire block once a real RADAR-class asset flows
  // through the pipeline (see tests/hero_scenario_v3/README.md
  // follow-up #7 — GLB rendering survey covers the broader work).
  const forceClass = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('force')
    : null;
  const assetClass = forceClass === 'radar' ? 'RADAR' : platformClass(variant);
  const coreTemp = tel?.sustainment?.thermal?.component_temperature?.value ?? 32.0;

  const radarAssets = fleet.data.map((a) => ({
    id: a.asset_id,
    type: a.platform_variant ?? '',
    node_id: '',
  }));

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <Header
        link1={link1} setLink1={setLink1}
        fleet={fleet.data}
        selectedAsset={selectedAssetId}
        setSelectedAsset={setSelectedAssetId}
        availableEdges={availableEdges}
        selectedEdge={selectedEdge}
        onSelectEdge={onSelectEdge}
      />

      {/* Phase 6c.3 corrected scope (per the recipe revision): the
          edge-change transit animation is contained to the GROUND
          DIAGNOSTICS schematic ONLY — not the entire content area.
          MaintainerApp threads selectedEdge into DiagnosticCanvas as
          transitTriggerKey; the schematic animates in place; everything
          else snaps. See EdgeTransit.tsx + DiagnosticCanvas's
          contentClassName seam through HudFrame. */}
      <main className="flex-1 grid grid-cols-3 grid-rows-[minmax(0,1fr)] gap-4 p-4 pt-2 overflow-hidden">
        {/* Left + center: identity strip + 3D schematic */}
        <div className="col-span-2 flex flex-col gap-4 overflow-hidden">
          <div className="panel flex items-center justify-between shrink-0 p-3">
            <div>
              <h2 className="text-sm text-slate-200 tracking-wider uppercase mb-1">
                {selectedAsset
                  ? selectedAsset.callsign || selectedAsset.asset_id
                  : 'No asset selected'}
              </h2>
              <div className="flex gap-4 text-[11px] text-slate-500">
                <span>variant: <span className="text-slate-300">{variant ?? 'unknown'}</span></span>
                <span>id: <span className="text-slate-300">{selectedAsset?.asset_id ?? '—'}</span></span>
                <span>force: <span className="text-slate-300">{selectedAsset?.force_id ?? '—'}</span></span>
                <span>last seen: <span className="text-slate-300">{formatSeen(selectedAsset?.last_sample_at ?? null)}</span></span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500 mb-1">LOCAL TIME</div>
              <div className="text-xl font-bold text-slate-200">{clock}</div>
            </div>
          </div>

          <div className="panel flex-1 relative overflow-hidden font-rajdhani font-semibold">
            <DiagnosticCanvas
              assetType={assetClass === 'RADAR' ? 'RADAR' : assetClass}
              degraded={degraded}
              coreTemp={coreTemp}
              transitTriggerKey={selectedEdge}
            />
            <LocalFleetRadar degraded={degraded} localAssets={radarAssets} />
          </div>
        </div>

        {/* Right: per-asset detail cards. isLoading is threaded so each
            panel shows a syncing state on cold start instead of flashing
            its genuinely-empty copy before the where-filtered shape has
            completed its first sync. */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2 min-h-0">
          <CmStateCard cm={cmState} isLoading={cm.isLoading} />
          <LogisticsStatusCard logistics={logiState} isLoading={logistics.isLoading} />
          <TelemetryCharts telemetry={tel} platformVariant={variant} degraded={degraded} isLoading={telemetry.isLoading} />
          <AlertFeed events={events.data} isLoading={events.isLoading} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default MaintainerApp;
