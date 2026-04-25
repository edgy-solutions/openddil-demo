import { Globe, ChevronRight } from 'lucide-react';

export default function HqDigitalTwin({ wanActive }: { wanActive: boolean }) {
  return (
    <div className={`panel flex-1 flex flex-col overflow-hidden p-3 transition-colors duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`}>
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Globe className={`w-4 h-4 mr-2 transition-colors ${wanActive ? 'text-emerald-400' : 'text-rose-500'}`} /> 
        EAGLE Enterprise Digital Twin
      </h2>
      
      <div className="flex-1 overflow-y-auto text-xs font-mono space-y-1 pr-2 pb-2 select-none">
        
        {/* Theater: EUCOM */}
        <details open className="mb-2">
          <summary className="flex items-center p-1.5 bg-slate-800/50 hover:bg-slate-800 border border-slate-700 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <span className="flex-1 font-bold text-slate-200 tracking-widest">EUCOM THEATER</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1 shadow-[0_0_5px_#10b981]"></span>
          </summary>
          <div className="tree-node space-y-1 py-1 text-slate-400 mt-1">
            <details open>
              <summary className="flex items-center justify-between p-1 hover:bg-slate-800 rounded group cursor-pointer">
                <span className="flex items-center"><ChevronRight className="w-3 h-3 mr-1 opacity-50 group-open:rotate-90" /> Med-East Region Hub</span>
                <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">ONLINE</span>
              </summary>
              <div className="tree-node py-1 text-[10px] space-y-1">
                <div className="flex justify-between hover:bg-slate-800 p-1 rounded"><span>Battery Bravo</span> <span className="text-emerald-400">NOMINAL</span></div>
                <div className="flex justify-between hover:bg-slate-800 p-1 rounded"><span>Battery Foxtrot</span> <span className="text-emerald-400">NOMINAL</span></div>
                <div className="flex justify-between hover:bg-slate-800 p-1 rounded"><span>Battery Uniform</span> <span className="text-emerald-400">NOMINAL</span></div>
              </div>
            </details>
            <details>
              <summary className="flex items-center justify-between p-1 hover:bg-slate-800 rounded group cursor-pointer">
                <span className="flex items-center"><ChevronRight className="w-3 h-3 mr-1 opacity-50 group-open:rotate-90" /> Baltic Region Hub</span>
                <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">ONLINE</span>
              </summary>
            </details>
          </div>
        </details>

        {/* Theater: INDO-PACOM */}
        <details open className="mb-2">
          <summary className="flex items-center p-1.5 bg-slate-800/50 hover:bg-slate-800 border border-slate-700 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <span className="flex-1 font-bold text-slate-200 tracking-widest">INDO-PACOM THEATER</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1 shadow-[0_0_5px_#10b981]"></span>
          </summary>
          <div className="tree-node space-y-1 py-1 text-slate-400 mt-1">
            <details>
              <summary className="flex items-center justify-between p-1 hover:bg-slate-800 rounded group cursor-pointer">
                <span className="flex items-center"><ChevronRight className="w-3 h-3 mr-1 opacity-50 group-open:rotate-90" /> PACFLT Hub Alpha</span>
                <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">ONLINE</span>
              </summary>
            </details>
          </div>
        </details>

      </div>
    </div>
  );
}