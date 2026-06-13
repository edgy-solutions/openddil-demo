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
import LostContactBanner from './components/LostContactBanner';
import TelemetryCharts from './components/TelemetryCharts';
import AlertFeed from './components/AlertFeed';
import Inventory from './components/Inventory';
import CmStateCard from './components/CmStateCard';
import { StrikeCapabilityCard } from './components/StrikeCapabilityCard';
import GroundDiagnosticsCard from './components/GroundDiagnosticsCard';
import LogisticsStatusCard from './components/LogisticsStatusCard';
import {
  useFleetAssets,
  useFleetAssetsForEdge,
  useFleetTiers,
  useTelemetryLatest,
  useCmState,
  useLogisticsStatus,
  useTacticalEvents,
} from './hooks';
import { platformClass } from './config/platformChartConfig';
import { deployment } from './deployment';

// =============================================================================
// Maintainer-actionable platform variants
// =============================================================================
// The fleet hook (useFleetAssetsForEdge) correctly returns ALL entities at
// the FOB — mobile tactical equipment AND stationary infrastructure
// (facilities, headquarters, civilian sites). HQ and Regional views show
// all of them as operational context.
//
// But "asset is at this FOB" and "maintainer can work on this asset" are
// different questions. Tactical maintainers work on Category 1 (mobile
// equipment) and Category 2 (stationary tactical equipment — sensors,
// interceptors, launchers). Category 3 (real estate — facility buildings,
// HQ complexes, civilian installations) is base ops / facilities
// engineering, NOT a tactical-maintainer scope.
//
// This set is the maintainer-dropdown filter ONLY. The map, fleet count,
// and HQ/Regional views all use the unfiltered fleet from the same hook.
// Same architectural pattern as platform_variant_aliases.yaml — explicit
// registry of which variants belong in a given context.
//
// Edge case: AIR_DEFENSE_SITE is named like a facility (parallel with
// HEADQUARTER_COMPLEX and INSTALLATION_FACILITY_CIVILIAN). Treated as
// real estate here. If the ORBAT data ever uses it as a leaf-level
// asset (rather than a parent grouping with sensors/interceptors as
// children), revisit this filter.
const MAINTAINER_ACTIONABLE_VARIANTS = new Set<string>([
  // Category 1 — mobile tactical equipment
  'M1A2-SEPv3', 'M1A2-SEPv2', 'AH-64E', 'AH-64E-V6',
  // Category 2 — stationary tactical equipment
  'CUAS_Sensor', 'VSHORAD_Sensor', 'SHORAD_Sensor', 'MRAD_Sensor',
  'CUAS_Interceptor', 'VSHORAD_Interceptor', 'SHORAD_Interceptor', 'MRAD_Interceptor',
  'MISSILE_LAUNCHER',
]);

// Phase 6c.2: edge-scope mechanism (pulldown + ?edge= URL param). The
// available-edges list is derived from useFleetAssets().data distinct
// edge_ids (symmetric with §C.1's region-from-summary pattern). The
// regex below pins the URL-param shape so a malformed value (?edge=foo)
// is rejected rather than passed to the Shape API as a where-clause.
//
// Accepts any kebab-case identifier — keeps URL-injection protection
// while supporting FOB-coded edge_ids (`fob-alpha`, `***`, ...)
// alongside legacy `edge-XX` values. The maintainer picker is the
// operator view; FOB is the operator's mental model, not "edge."
const EDGE_ID_PATTERN = /^[a-zA-Z0-9-]+$/;
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

  // 5-tier liveness per asset (see lib/assetTier). Drives the picker
  // suffix + the dim styling in Header so the operator can still
  // navigate to a STALE / COMM_LOST / LOST asset from this pulldown
  // while seeing its current state at a glance. link1=false means
  // the operator has flipped the DDIL toggle (severed link); we feed
  // that into the classifier so silent assets read as COMM_LOST
  // rather than generic STALE.
  const tiers = useFleetTiers(fleet.data, !link1);

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

  // Radar plots real lat/lon (via FleetAsset.position from
  // telemetry_latest_state) projected to a 2D frame centered on the
  // currently-selected edge's FOB. Earlier the radar placed assets at
  // synthetic circular positions by array index; now it shows real
  // geographic relationships at radar scale (<100km neighborhood).
  const radarAssets = useMemo(
    () => fleet.data.map((a) => ({
      id: a.asset_id,
      type: a.platform_variant ?? '',
      node_id: '',
      lat: a.position?.lat ?? null,
      lon: a.position?.lon ?? null,
    })),
    [fleet.data],
  );

  // Radar center — the FOB hosting the selected edge. Maintainer's
  // "you are here" anchor for the radar projection. Falls back to null
  // when no edge is selected (cold start); the radar then uses its
  // synthetic-placement fallback so the view doesn't go blank.
  const radarCenter = useMemo(() => {
    if (!selectedEdge) return { lat: null, lon: null };
    const fob = deployment().fobs.find((f) => f.edge_id === selectedEdge);
    return fob ? { lat: fob.lat, lon: fob.lon } : { lat: null, lon: null };
  }, [selectedEdge]);

  // Maintainer asset dropdown filter: scope to maintainer-actionable
  // variants only (see MAINTAINER_ACTIONABLE_VARIANTS above). The
  // unfiltered fleet still drives the rest of the view + HQ/Regional.
  const fleetForPicker = useMemo(
    () => fleet.data.filter((a) =>
      a.platform_variant != null && MAINTAINER_ACTIONABLE_VARIANTS.has(a.platform_variant),
    ),
    [fleet.data],
  );

  return (
    <div className="font-mono h-full flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <Header
        link1={link1} setLink1={setLink1}
        fleet={fleetForPicker}
        fleetTiers={tiers}
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
      <main className="flex-1 grid grid-cols-3 grid-rows-[minmax(0,1fr)] gap-4 p-4 pt-2 overflow-hidden min-h-0">
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

          {/* Phase 4c: forensics banner. Renders ONLY when the selected
              asset's tier is STALE / COMM_LOST / LOST -- makes the
              "this asset is silent, here's its last contact" narrative
              explicit so the operator doesn't read the (frozen)
              CmStateCard / TelemetryCharts below as current state.
              Returns null for live (ACTIVE/DEGRADED) selections; layout
              snaps tight. */}
          <LostContactBanner
            tier={selectedAssetId ? tiers.get(selectedAssetId) : undefined}
            lastSampleAt={selectedAsset?.last_sample_at ?? null}
          />

          <div className="panel flex-1 relative overflow-hidden font-rajdhani font-semibold">
            <DiagnosticCanvas
              platformVariant={variant}
              assetType={assetClass === 'RADAR' ? 'RADAR' : undefined}
              assetId={selectedAssetId}
              degraded={degraded}
              coreTemp={coreTemp}
              transitTriggerKey={selectedEdge}
              operationalState={tel?.operational_state ?? null}
            />
            <LocalFleetRadar
              degraded={degraded}
              localAssets={radarAssets}
              centerLat={radarCenter.lat}
              centerLon={radarCenter.lon}
              selectedAssetId={selectedAssetId}
            />
          </div>
        </div>

        {/* Right: per-asset detail cards. isLoading is threaded so each
            panel shows a syncing state on cold start instead of flashing
            its genuinely-empty copy before the where-filtered shape has
            completed its first sync. */}
        {/* Explicit viewport-bounded max-h: the grid-rows + min-h-0 chain
            empirically did not constrain the column to viewport on its
            own (panels overflowed past the fold with no scrollbar). The
            calc bypasses the chain — 140px = Root dev nav bar (h-10 =
            40px) + Header (panel + m-2 + p-3 + border-b-2 + content,
            ~92px) with slop. 100vh inside the calc references the actual
            viewport, NOT the role-view's allocated space, so the nav
            bar must be subtracted here even though MaintainerApp itself
            doesn't render it. */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-4 min-h-0 max-h-[calc(100vh-140px)]">
          <CmStateCard cm={cmState} isLoading={cm.isLoading} />
          {/* Phase 5: ADR-0026 operational_state surfaced per-asset.
              Sits between CmStateCard (config-management compliance) and
              LogisticsStatusCard (rolled-up severity from fusion) — the
              3-axis posture is orthogonal to both. */}
          <GroundDiagnosticsCard
            opState={tel?.operational_state ?? null}
            isLoading={telemetry.isLoading}
          />
          <LogisticsStatusCard
            logistics={logiState}
            opState={tel?.operational_state ?? null}
            isLoading={logistics.isLoading}
          />
          {/* Strike-only card: renders nothing on non-strike-capable assets
              (sensors, HQ, infrastructure) so the right-rail stays clean.
              Shows ammo per weapon/store with LOW/DEPLETED banding once
              levels cross the configured threshold. */}
          <StrikeCapabilityCard assetId={selectedAssetId} />
          <TelemetryCharts telemetry={tel} platformVariant={variant} degraded={degraded} isLoading={telemetry.isLoading} />
          <AlertFeed events={events.data} isLoading={events.isLoading} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default MaintainerApp;
