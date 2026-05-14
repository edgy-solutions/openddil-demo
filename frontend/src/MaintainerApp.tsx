// =============================================================================
// MaintainerApp — the maintainer view (per-asset detail)
// =============================================================================
// Phase 4c. Renamed from App.tsx (the Phase 4b "edge view") and expanded
// into the maintainer-focused per-asset detail view: a fleet picker plus,
// for the selected asset, an identity strip, a CM state card, a logistics
// status card, the sustainment telemetry panel, an asset-filtered event
// feed, and the 3D schematic (LtamdsView for RADAR-class via
// DiagnosticCanvas, GenericSchematic otherwise).
//
// All pipeline data comes from ElectricSQL Shapes (./hooks). Phase 4c.5:
// the link toggle now severs/restores the REAL toxiproxy hq-link proxy,
// and the edge-buffer counter (in Header) reads real bridge-group lag via
// useEdgeBuffer — no more client-side simulation.
import { useState, useEffect } from 'react';
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
  useTelemetryLatest,
  useCmState,
  useLogisticsStatus,
  useTacticalEvents,
} from './hooks';
import { platformClass } from './config/platformChartConfig';

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

  // Pipeline data — ElectricSQL Shapes, no polling.
  const fleet = useFleetAssets();
  const telemetry = useTelemetryLatest(selectedAssetId);
  const cm = useCmState(selectedAssetId);
  const logistics = useLogisticsStatus(selectedAssetId);
  // Maintainer view: recent events filtered to the selected asset.
  const events = useTacticalEvents(10, selectedAssetId);

  // Default the selected asset to the first in the fleet; re-home if the
  // current selection drops out of the fleet.
  useEffect(() => {
    if (fleet.data.length === 0) return;
    const stillPresent = fleet.data.some((a) => a.asset_id === selectedAssetId);
    if (!selectedAssetId || !stillPresent) {
      setSelectedAssetId(fleet.data[0].asset_id);
    }
  }, [fleet.data, selectedAssetId]);

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
  const assetClass = platformClass(variant);
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
      />

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden">
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
            <DiagnosticCanvas assetType={assetClass === 'RADAR' ? 'RADAR' : assetClass} degraded={degraded} coreTemp={coreTemp} />
            <LocalFleetRadar degraded={degraded} localAssets={radarAssets} />
          </div>
        </div>

        {/* Right: per-asset detail cards. isLoading is threaded so each
            panel shows a syncing state on cold start instead of flashing
            its genuinely-empty copy before the where-filtered shape has
            completed its first sync. */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
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
