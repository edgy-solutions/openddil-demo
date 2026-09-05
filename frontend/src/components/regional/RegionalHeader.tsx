// =============================================================================
// RegionalHeader — regional-view toolbar
// =============================================================================
// Phase 4c.5: the regional buffer and link status are now REAL — read
// from useEdgeBuffer() (the edge_buffer_status shape). The link toggle
// severs/restores the real toxiproxy hq-link proxy. The vestigial second
// link toggle (link2) was removed.
import { Laptop, Server, Building2, TrendingUp, Settings } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { useEdgeBuffer } from '../../hooks';

interface RegionalHeaderProps {
  link1: boolean;
  setLink1: (v: boolean) => void;
  setIsRuleEditorOpen: (v: boolean) => void;
}

export default function RegionalHeader({ link1, setLink1, setIsRuleEditorOpen }: RegionalHeaderProps) {
  const { status } = useEdgeBuffer();
  const severed = status ? status.hq_link_severed : !link1;
  const lag = status?.bridge_group_lag ?? 0;
  const probeDown = status != null && !status.probe_healthy;
  const linkLabel = probeDown ? 'LINK: PROBE DOWN' : severed ? 'DDIL: LINK SEVERED' : 'EDGE↔HQ: LINK UP';

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-slate-400">
          <Laptop className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">TACTICAL EDGE</span>
        </div>

        {/* DDIL link — the toggle severs/restores the real toxiproxy hq-link */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${severed ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <div className="relative inline-block w-12 mr-2 align-middle select-none transition duration-200 ease-in mt-1">
            <input
              type="checkbox"
              id="rtoggle1"
              className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0"
              checked={link1}
              onChange={(e) => setLink1(e.target.checked)}
            />
            <label htmlFor="rtoggle1" className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${link1 ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${link1 ? 'translate-x-full' : ''}`}></span>
            </label>
          </div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${probeDown ? 'text-amber-400' : severed ? 'text-rose-500 glow-rose' : 'text-emerald-400'}`}>
            {linkLabel}
          </span>
        </div>

        <div className="flex flex-col items-center text-emerald-400">
          <Server className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">REGIONAL HUB <ThisNodeBadge /></span>
        </div>

        {/* Link bar between REGIONAL HUB and CENTRAL HQ — mirrors the
            HqHeader pattern (TACTICAL EDGE → REGIONAL HUBS uses a
            static green-dot link bar; this is the same visual for the
            regional→HQ hop). Reflects the SAME `severed` state as the
            edge↔hub link bar above because the demo's hq-link is
            shared (one toxiproxy proxy; severing the link severs both
            hops from this view's perspective). No second toggle — the
            existing toggle drives the shared sever. Without this, the
            CENTRAL HQ icon sat visually disconnected after the
            REGIONAL HUB node. */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${severed ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <div className={`w-3 h-3 rounded-full mt-1.5 ${severed ? 'bg-rose-500' : 'bg-emerald-500 shadow-[0_0_10px_#10b981]'}`}></div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${probeDown ? 'text-amber-400' : severed ? 'text-rose-500 glow-rose' : 'text-emerald-400'}`}>
            {probeDown ? 'REGIONAL↔HQ: PROBE DOWN' : severed ? 'REGIONAL↔HQ: SEVERED' : 'REGIONAL↔HQ: LINK UP'}
          </span>
        </div>

        <div className="flex flex-col items-center text-slate-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">CENTRAL HQ</span>
        </div>

        <div className="flex flex-col items-center justify-center mr-4">
          <button
            onClick={() => setIsRuleEditorOpen(true)}
            className="flex items-center gap-2 bg-cyan-900/40 hover:bg-cyan-800/60 border border-cyan-700/50 text-cyan-400 px-3 py-2 rounded transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="text-[10px] font-bold tracking-widest">CONFIGURE HEURISTICS</span>
          </button>
        </div>

        {/* Real edge-buffer depth: bridge-group consumer lag on redpanda-edge */}
        <div className="pl-6 border-l border-slate-700 min-w-[160px]">
          <div className="text-[10px] text-slate-400 tracking-wider">EDGE→HQ BUFFER</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">
              {probeDown ? '—' : lag > 1000 ? (lag / 1000).toFixed(1) + 'K' : lag}
            </span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${lag === 0 ? 'opacity-0' : 'opacity-100'} ${severed ? 'text-rose-500' : 'text-emerald-500 rotate-180'}`} />
          </div>
        </div>
      </div>
    </header>
  );
}
