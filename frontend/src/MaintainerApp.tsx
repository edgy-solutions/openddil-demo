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
// All pipeline data comes from ElectricSQL Shapes (./hooks). The link
// toggles + Toxiproxy uplink demo + edge-buffer counter are UI demo
// mechanics carried over from 4b — see the Phase 4c checkpoint for the
// finding on the edge-buffer / DDIL-sever wiring.
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
  // UI demo state — not pipeline data.
  const [link1, setLink1] = useState(true);
  const [link2, setLink2] = useState(true);
  const [buffer, setBuffer] = useState(0);
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

  // Toxiproxy uplink-sever demo. NOTE (Phase 4c finding): the hq-link
  // proxy is not registered at runtime (toxiproxy starts without -config),
  // so this POST currently 404s silently — see the 4c checkpoint.
  useEffect(() => {
    const handleToxiproxy = async (enabled: boolean) => {
      try {
        if (!enabled) {
          await fetch('/proxies/hq-link/toxics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'timeout_down',
              type: 'timeout',
              stream: 'downstream',
              toxicity: 1.0,
              attributes: { timeout: 0 },
            }),
          });
        } else {
          await fetch('/proxies/hq-link/toxics/timeout_down', { method: 'DELETE' });
        }
      } catch (e) {
        console.error('Toxiproxy error', e);
      }
    };
    handleToxiproxy(link1);
  }, [link1]);

  // link1 drives the degraded UI state.
  useEffect(() => {
    if (!link1 && !degraded) setDegraded(true);
    else if (link1 && degraded) setDegraded(false);
  }, [link1, degraded]);

  // Clock + edge-buffer simulation. No data fetches — pipeline data is
  // push-based via the shape hooks above.
  useEffect(() => {
    const interval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
      setBuffer((prev) => {
        if (!link1 || !link2) return prev + Math.floor(Math.random() * 45) + 10;
        if (prev > 0) return Math.max(0, prev - Math.floor(prev * 0.2) - 100);
        return prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, [link1, link2]);

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
        link2={link2} setLink2={setLink2}
        buffer={buffer}
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

        {/* Right: per-asset detail cards */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <CmStateCard cm={cmState} />
          <LogisticsStatusCard logistics={logiState} />
          <TelemetryCharts telemetry={tel} platformVariant={variant} degraded={degraded} />
          <AlertFeed events={events.data} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default MaintainerApp;
