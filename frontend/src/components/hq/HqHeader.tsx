// =============================================================================
// HqHeader — HQ-view toolbar
// =============================================================================
// Phase 4c.5: the global buffer backlog is REAL — read from useEdgeBuffer()
// (the edge_buffer_status shape). HQ is the root of the tree and has no
// uplink, so there is no link toggle here: each tier's link is cut from its
// own child's screen, and HQ's per-link controls and reachability live in
// TheaterReadinessPosture (DIRECT LINKS / GLOBAL LINK STATUS).
import { Laptop, Server, Building2, TrendingUp } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { useEdgeBuffer } from '../../hooks';
import ExercisePopup from './ExercisePopup';

export default function HqHeader() {
  const { status } = useEdgeBuffer();
  const lag = status?.bridge_group_lag ?? 0;
  const probeDown = status != null && !status.probe_healthy;

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700 transition-colors duration-500">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-slate-500">
          <Laptop className="w-6 h-6 mb-1 text-slate-600" />
          <span className="text-[10px] font-bold tracking-wider">TACTICAL EDGE</span>
        </div>
        <div className="flex-1 flex flex-col items-center relative">
          <div className="absolute w-full h-[2px] bg-slate-700 top-3 -z-10"></div>
          <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981] mt-1.5"></div>
        </div>
        <div className="flex flex-col items-center text-slate-400">
          <Server className="w-6 h-6 mb-1 text-slate-300" />
          <span className="text-[10px] font-bold tracking-wider">REGIONAL HUBS</span>
        </div>
        <div className="flex-1 flex flex-col items-center relative">
          <div className="absolute w-full h-[2px] bg-slate-700 top-3 -z-10"></div>
          <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981] mt-1.5"></div>
        </div>
        {/* Exercise control -- a separate capability from link control
            (controls the DIS simulator/adapter via its own service, never a
            link). Self-contained: polls its own status, so it takes no props
            from this header. */}
        <ExercisePopup />
        <div className="flex flex-col items-center text-emerald-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">CENTRAL HQ <ThisNodeBadge /></span>
        </div>

        {/* Real edge-buffer backlog: bridge-group consumer lag on redpanda-edge */}
        <div className="pl-6 border-l border-slate-700 min-w-[160px]">
          <div className="text-[10px] text-slate-400 tracking-wider">GLOBAL BUFFER BACKLOG</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">
              {probeDown ? '—' : lag > 1000 ? (lag / 1000).toFixed(1) + 'K' : lag}
            </span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${lag === 0 ? 'opacity-0' : 'opacity-100'} text-emerald-500 rotate-180`} />
          </div>
        </div>
      </div>
    </header>
  );
}
