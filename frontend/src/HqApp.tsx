// =============================================================================
// HqApp — the HQ view (enterprise fleet analytics)
// =============================================================================
// Phase 4c rewrite. Was hardcoded enterprise work orders + a theater tree.
// Now a real enterprise dashboard from the shape hooks: fleet-wide
// readiness (CM status + logistics severity counts), MWO/TCTO compliance
// by platform family, baseline version distribution, fleet wear-trend
// rollup, the enterprise fleet tree (HqDigitalTwin), and CM-derived
// actionable items (HqWorkOrders).
//
// Phase 4c.5: the WAN-cut demo is now REAL. The toggle severs/restores
// the toxiproxy hq-link proxy (now loaded via -config); the buffer
// backlog and link status come from useEdgeBuffer (the edge_buffer_status
// shape the projector's monitor writes from real bridge-group lag); the
// freeze overlay shows when the link is genuinely severed.
import { useState, useMemo } from 'react';
import HqHeader from './components/hq/HqHeader';
import TheaterReadinessPosture from './components/hq/TheaterReadinessPosture';
import HqDigitalTwin from './components/hq/HqDigitalTwin';
import HqWorkOrders from './components/hq/HqWorkOrders';
import { AlertOctagon } from 'lucide-react';
import {
  useAllCmState,
  useAllLogisticsStatus,
  useFleetAssets,
  useAllTelemetryWindows,
  useEdgeBuffer,
} from './hooks';
import {
  cmComplianceSummary,
  logisticsSeveritySummary,
  mwoComplianceByFamily,
  baselineDistribution,
  wearTrendRollup,
  shortCmStatus,
  shortSeverity,
} from './lib/fleetAggregates';

// --- readiness panels (inline — HQ-specific rollup displays) ----------------

function FleetReadiness({
  cm, logistics,
}: {
  cm: ReturnType<typeof useAllCmState>['data'];
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'];
}) {
  const cmBuckets = useMemo(() => cmComplianceSummary(cm), [cm]);
  const sevBuckets = useMemo(() => logisticsSeveritySummary(logistics), [logistics]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Fleet-Wide Readiness</h2>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">CM status</div>
          {cmBuckets.length === 0 && <div className="text-xs text-slate-500">—</div>}
          {cmBuckets.map((b) => (
            <div key={b.status} className="flex justify-between text-xs">
              <span className="text-slate-400">{shortCmStatus(b.status)}</span>
              <span className="text-slate-200 font-bold">{b.count}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Logistics severity</div>
          {sevBuckets.length === 0 && <div className="text-xs text-slate-500">—</div>}
          {sevBuckets.map((b) => (
            <div key={b.severity} className="flex justify-between text-xs">
              <span className="text-slate-400">{shortSeverity(b.severity)}</span>
              <span className="text-slate-200 font-bold">{b.count}</span>
            </div>
          ))}
        </div>
      </div>
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

function WearTrends({ windows }: { windows: ReturnType<typeof useAllTelemetryWindows>['data'] }) {
  const rollup = useMemo(() => wearTrendRollup(windows), [windows]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Fleet Wear Trends</h2>
      {rollup.length === 0 ? (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-2 rounded-sm">
          No windowed wear data. Windowed telemetry is sparse — the DIS feed
          produces none (see ADR-0020); sustainment-rich feeds (sim-a /
          proprietary) drive the windowing path.
        </div>
      ) : (
        <div className="space-y-1">
          {rollup.map((r) => (
            <div key={r.component_key} className="flex justify-between text-xs">
              <span className="text-slate-300">{r.component_key}</span>
              <span className="text-slate-400">{r.assetCount} asset{r.assetCount === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HqApp() {
  const [wanActive, setWanActive] = useState(true);

  // Pipeline data — ElectricSQL Shapes.
  const cm = useAllCmState();
  const logistics = useAllLogisticsStatus();
  const fleet = useFleetAssets();
  const windows = useAllTelemetryWindows();
  const edge = useEdgeBuffer();
  // Real observed link state; the freeze overlay shows when the edge->HQ
  // link is genuinely severed, not just commanded.
  const severed = edge.status ? edge.status.hq_link_severed : !wanActive;

  // The "God Switch" — disables/enables the real toxiproxy hq-link proxy
  // (registered at runtime as of Phase 4c.5: toxiproxy now loads -config).
  // Disable, not a toxic: toxiproxy then closes connections and refuses
  // new ones, so the edge-hq-bridge genuinely cannot reach redpanda-hq.
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

      {/* Global Freeze Overlay — driven by the REAL hq-link sever state. */}
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
        {/* One real hq-link: severed => 0 up / 1 down, else 1 up / 0 down. */}
        <TheaterReadinessPosture wanActive={!severed} linksUp={severed ? 0 : 1} linksDown={severed ? 1 : 0} />

        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <FleetReadiness cm={cm.data} logistics={logistics.data} />
          <ConfigurationPosture cm={cm.data} fleet={fleet.data} />
          <WearTrends windows={windows.data} />
          <HqDigitalTwin wanActive={!severed} />
          <HqWorkOrders wanActive={!severed} />
        </div>
      </main>
    </div>
  );
}
