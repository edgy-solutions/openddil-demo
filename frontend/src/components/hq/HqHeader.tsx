// =============================================================================
// HqHeader — HQ-view toolbar
// =============================================================================
// Phase 4c.5: the global buffer backlog and WAN link status are now REAL
// — read from useEdgeBuffer() (the edge_buffer_status shape). The WAN
// toggle severs/restores the real toxiproxy hq-link proxy.
import { Laptop, Server, Building2, TrendingUp } from 'lucide-react';
import { useEdgeBuffer } from '../../hooks';

interface HqHeaderProps {
  wanActive: boolean;
  setWanActive: (v: boolean) => void;
}

export default function HqHeader({ wanActive, setWanActive }: HqHeaderProps) {
  const { status } = useEdgeBuffer();
  const severed = status ? status.hq_link_severed : !wanActive;
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
        {/* WAN link — the toggle severs/restores the real toxiproxy hq-link */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${severed ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <div className="relative inline-block w-12 mr-2 align-middle select-none transition duration-200 ease-in mt-1">
            <input
              type="checkbox"
              id="toggle2"
              className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0"
              checked={wanActive}
              onChange={(e) => setWanActive(e.target.checked)}
            />
            <label htmlFor="toggle2" className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${wanActive ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${wanActive ? 'translate-x-full' : ''}`}></span>
            </label>
          </div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${probeDown ? 'text-amber-400' : severed ? 'text-rose-500 glow-rose' : 'text-emerald-400'}`}>
            {probeDown ? 'HQ WAN: PROBE DOWN' : severed ? 'HQ WAN: SEVERED' : 'HQ WAN: ACTIVE'}
          </span>
        </div>
        <div className="flex flex-col items-center text-emerald-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">CENTRAL HQ <span className="bg-emerald-500/20 px-1 py-0.5 rounded text-[8px] ml-1">THIS NODE</span></span>
        </div>

        {/* Real edge-buffer backlog: bridge-group consumer lag on redpanda-edge */}
        <div className="pl-6 border-l border-slate-700 min-w-[160px]">
          <div className="text-[10px] text-slate-400 tracking-wider">GLOBAL BUFFER BACKLOG</div>
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
