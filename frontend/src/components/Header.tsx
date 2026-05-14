// =============================================================================
// Header — edge-view toolbar
// =============================================================================
// Phase 4b rewrite. The NODE (FOB) picker is gone: telemetry_latest_state
// carries no node_id, so there is no FOB grouping to drive it — that was
// mock-simulator structure. The ASSET picker is now populated from
// useFleetAssets() (real pipeline assets), labelled by callsign +
// platform_variant. Link toggles and the edge-buffer readout are unchanged.
import { Laptop, Server, Building2, TrendingUp } from 'lucide-react';
import type { FleetAsset } from '../hooks';
import { assetLabel } from '../lib/assetLabel';

interface HeaderProps {
  link1: boolean;
  setLink1: (v: boolean) => void;
  link2: boolean;
  setLink2: (v: boolean) => void;
  buffer: number;
  fleet: FleetAsset[];
  selectedAsset: string;
  setSelectedAsset: (v: string) => void;
}

// asset_id-first label (assetLabel) so assets with a shared callsign stay
// distinguishable in the picker; platform_variant appended for context.
function pickerLabel(a: FleetAsset): string {
  return a.platform_variant ? `${assetLabel(a)} (${a.platform_variant})` : assetLabel(a);
}

export default function Header({ link1, setLink1, link2, setLink2, buffer, fleet, selectedAsset, setSelectedAsset }: HeaderProps) {
  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        {/* Asset Context Switcher — populated from the real fleet (useFleetAssets) */}
        <div className="flex flex-col pr-6 border-r border-slate-700">
          <label className="text-[10px] text-slate-400 tracking-wider mb-1">ASSET</label>
          <div className="relative">
            <select
              value={selectedAsset}
              onChange={(e) => setSelectedAsset(e.target.value)}
              className="appearance-none w-64 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 cursor-pointer"
            >
              {fleet.length === 0 && <option value="">— no assets in pipeline —</option>}
              {fleet.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>{pickerLabel(a)}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center text-slate-400">
          <Laptop className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">TACTICAL EDGE</span>
        </div>

        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${link1 ? 'bg-slate-700' : 'bg-rose-900'}`}></div>
          <div className="relative inline-block w-12 mr-2 align-middle select-none transition duration-200 ease-in mt-1">
            <input
              type="checkbox"
              id="toggle1"
              className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0"
              checked={link1}
              onChange={(e) => setLink1(e.target.checked)}
            />
            <label htmlFor="toggle1" className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${link1 ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${link1 ? 'translate-x-full' : ''}`}></span>
            </label>
          </div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${link1 ? 'text-emerald-400' : 'text-rose-500 glow-rose'}`}>
            {link1 ? 'SATCOM: ALIVE' : 'DDIL: LOCAL ONLY'}
          </span>
        </div>
        <div className="flex flex-col items-center text-slate-400">
          <Server className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">REGIONAL HQ</span>
        </div>
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${link2 ? 'bg-slate-700' : 'bg-rose-900'}`}></div>
          <div className="relative inline-block w-12 mr-2 align-middle select-none transition duration-200 ease-in mt-1">
            <input
              type="checkbox"
              id="toggle2"
              className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0"
              checked={link2}
              onChange={(e) => setLink2(e.target.checked)}
            />
            <label htmlFor="toggle2" className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${link2 ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${link2 ? 'translate-x-full' : ''}`}></span>
            </label>
          </div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${link2 ? 'text-emerald-400' : 'text-rose-500 glow-rose'}`}>
            {link2 ? 'WAN: ACTIVE' : 'DDIL: ISOLATED'}
          </span>
        </div>
        <div className="flex flex-col items-center text-slate-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">CENTRAL HQ</span>
        </div>
        <div className="pl-6 border-l border-slate-700 min-w-[150px]">
          <div className="text-[10px] text-slate-400 tracking-wider">REDPANDA EDGE BUFFER</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">{buffer > 1000 ? (buffer / 1000).toFixed(1) + 'K' : buffer}</span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${buffer === 0 ? 'opacity-0' : 'opacity-100'} ${(!link1 || !link2) ? 'text-rose-500' : 'text-emerald-500 rotate-180'}`} />
          </div>
        </div>
      </div>
    </header>
  );
}
