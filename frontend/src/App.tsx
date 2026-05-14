// =============================================================================
// App — the edge / maintainer view
// =============================================================================
// Phase 4b rewrite. Was three polling loops against endpoints that mostly
// didn't exist (/simulator/assets, /api/telemetry, /api/alerts). Now every
// piece of pipeline data comes from ElectricSQL Shapes via the hooks in
// ./hooks — no polling, single read path.
//
// What stayed: the link1/link2 toggles, the Toxiproxy uplink-sever demo,
// the edge-buffer simulation. Those are UI demo mechanics, not pipeline
// data, and remain genuine.
import { useState, useEffect } from 'react';
import Header from './components/Header';
import DiagnosticCanvas from './components/DiagnosticCanvas';
import LocalFleetRadar from './components/LocalFleetRadar';
import TelemetryCharts from './components/TelemetryCharts';
import AlertFeed from './components/AlertFeed';
import Inventory from './components/Inventory';
import {
  useFleetAssets,
  useTelemetryLatest,
  useCmState,
  useLogisticsStatus,
  useTacticalEvents,
} from './hooks';
import { platformClass } from './config/platformChartConfig';

// CM overall_status -> badge classes.
function cmStatusBadge(status: string | undefined): { label: string; cls: string } {
  switch (status) {
    case 'CONFIG_STATUS_IN_COMPLIANCE':
      return { label: 'IN COMPLIANCE', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
    case 'CONFIG_STATUS_MINOR_DISCREPANCY':
      return { label: 'MINOR DISCREPANCY', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    case 'CONFIG_STATUS_MAJOR_DISCREPANCY':
      return { label: 'MAJOR DISCREPANCY', cls: 'bg-orange-500/20 text-orange-400 border-orange-500/50' };
    case 'CONFIG_STATUS_NOT_MISSION_CAPABLE':
      return { label: 'NOT MISSION CAPABLE', cls: 'bg-rose-500/20 text-rose-400 border-rose-500/50' };
    default:
      return { label: 'NO CM STATE', cls: 'bg-slate-700/40 text-slate-400 border-slate-600' };
  }
}

// Logistics overall_severity -> badge classes.
function severityBadge(sev: string | undefined): { label: string; cls: string } {
  switch (sev) {
    case 'LOGISTICS_SEVERITY_OK':
      return { label: 'OK', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' };
    case 'LOGISTICS_SEVERITY_DEGRADED':
      return { label: 'DEGRADED', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/50' };
    case 'LOGISTICS_SEVERITY_CRITICAL':
      return { label: 'CRITICAL', cls: 'bg-rose-500/20 text-rose-400 border-rose-500/50' };
    case 'LOGISTICS_SEVERITY_NON_OPERATIONAL':
      return { label: 'NON-OPERATIONAL', cls: 'bg-rose-700/30 text-rose-300 border-rose-700/60' };
    default:
      return { label: 'NO LOGISTICS STATE', cls: 'bg-slate-700/40 text-slate-400 border-slate-600' };
  }
}

function App() {
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
  const events = useTacticalEvents(100);

  // Default the selected asset to the first in the fleet; re-home if the
  // current selection drops out of the fleet.
  useEffect(() => {
    if (fleet.data.length === 0) return;
    const stillPresent = fleet.data.some((a) => a.asset_id === selectedAssetId);
    if (!selectedAssetId || !stillPresent) {
      setSelectedAssetId(fleet.data[0].asset_id);
    }
  }, [fleet.data, selectedAssetId]);

  // Toxiproxy uplink-sever demo: link1 off => add a timeout toxic to the
  // hq-link proxy; link1 on => remove it. This is the genuine offline-first
  // mechanic and stays.
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
    if (!link1 && !degraded) {
      setDegraded(true);
    } else if (link1 && degraded) {
      setDegraded(false);
    }
  }, [link1, degraded]);

  // Clock + edge-buffer simulation. No data fetches — pipeline data is
  // push-based via the shape hooks above.
  useEffect(() => {
    const interval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
      setBuffer((prev) => {
        if (!link1 || !link2) {
          return prev + Math.floor(Math.random() * 45) + 10;
        } else if (prev > 0) {
          return Math.max(0, prev - Math.floor(prev * 0.2) - 100);
        }
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

  const cmBadge = cmStatusBadge(cmState?.overall_status);
  const sevBadge = severityBadge(logiState?.overall_severity);

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
        {/* Left Column */}
        <div className="col-span-2 flex flex-col gap-4 overflow-hidden">
          {/* Asset status header — real CM + logistics state */}
          <div className="panel flex items-center justify-between shrink-0 p-3">
            <div>
              <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">
                {selectedAsset
                  ? `${selectedAsset.callsign || selectedAsset.asset_id} — ${variant ?? 'unknown variant'}`
                  : 'No asset selected'}
              </h2>
              <div className="flex space-x-4">
                <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                  <span className="text-xs text-slate-500">CM</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${cmBadge.cls}`}>
                    {cmBadge.label}
                  </span>
                </div>
                <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                  <span className="text-xs text-slate-500">LOGISTICS</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${sevBadge.cls}`}>
                    {sevBadge.label}
                  </span>
                </div>
                <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                  <span className="text-xs text-slate-500">UPLINK</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${degraded ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                    {degraded ? 'DEGRADED' : 'NOMINAL'}
                  </span>
                </div>
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

        {/* Right Column */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <TelemetryCharts telemetry={tel} platformVariant={variant} degraded={degraded} />
          <AlertFeed events={events.data} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default App;
