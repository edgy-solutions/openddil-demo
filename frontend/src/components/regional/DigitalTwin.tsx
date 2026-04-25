import React from 'react';
import { Network, ChevronRight, Radar } from 'lucide-react';

export default function DigitalTwin({ degradedBravo }: { degradedBravo: boolean }) {
  return (
    <div className="panel flex-1 flex flex-col overflow-hidden p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Network className="w-4 h-4 mr-2 text-emerald-400" /> Regional Assets Digital Twin
      </h2>
      
      <div className="flex-1 overflow-y-auto text-xs font-mono space-y-1 pr-2 pb-2 select-none" id="digital-twin-tree">
        
        {/* Battery Bravo */}
        <details open className="mb-1">
          <summary className="flex items-center p-1.5 hover:bg-slate-800 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <Radar className="w-4 h-4 mr-2 text-slate-400" />
            <span className="flex-1 font-bold text-slate-200">Battery Bravo (LTAMDS-04)</span>
            <span className={`w-2 h-2 rounded-full mr-1 ${degradedBravo ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></span>
          </summary>
          <div className="tree-node space-y-1 py-1 text-slate-400">
            <div className="flex items-center justify-between p-1 hover:bg-slate-800 rounded">
              <span>Power Generation</span>
              <span className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">NOMINAL</span>
            </div>
            <details open>
              <summary className="flex items-center justify-between p-1 hover:bg-slate-800 rounded group cursor-pointer">
                <span className="flex items-center">
                  <ChevronRight className="w-3 h-3 mr-1 opacity-50 group-open:rotate-90" /> Primary Array
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded border ${degradedBravo ? 'bg-rose-500/20 text-rose-400 border-rose-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'}`}>
                  {degradedBravo ? 'OFFLINE/NO_COMMS' : 'NOMINAL'}
                </span>
              </summary>
              <div className="tree-node py-1 text-[10px] space-y-1">
                <div className="flex justify-between"><span>Core Temp</span> <span className="text-cyan-400">42.1°C</span></div>
                <div className="flex justify-between"><span>T/R Modules</span> <span className="text-emerald-400">100%</span></div>
              </div>
            </details>
            <div className="flex items-center justify-between p-1 hover:bg-slate-800 rounded">
              <span>Coolant Subsystem</span>
              <span className="text-[9px] bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">NOMINAL</span>
            </div>
          </div>
        </details>

        {/* Battery Foxtrot */}
        <details open className="mb-1">
          <summary className="flex items-center p-1.5 hover:bg-slate-800 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <Radar className="w-4 h-4 mr-2 text-slate-400" />
            <span className="flex-1 font-bold text-slate-200">Battery Foxtrot (LTAMDS-07)</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>
          </summary>
          <div className="tree-node space-y-1 py-1 text-slate-400">
            <div className="flex items-center justify-between p-1 hover:bg-slate-800 rounded">
              <span>Primary Array</span>
              <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">NOMINAL</span>
            </div>
          </div>
        </details>

        {/* Battery Uniform */}
        <details className="mb-1">
          <summary className="flex items-center p-1.5 hover:bg-slate-800 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <Radar className="w-4 h-4 mr-2 text-slate-400" />
            <span className="flex-1 font-bold text-slate-200">Battery Uniform (LTAMDS-02)</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>
          </summary>
          <div className="tree-node py-1 text-slate-400">...</div>
        </details>
        
        {/* Battery Echo */}
        <details className="mb-1">
          <summary className="flex items-center p-1.5 hover:bg-slate-800 rounded transition-colors group">
            <ChevronRight className="w-3 h-3 mr-1 text-slate-500 group-open:rotate-90 transition-transform" />
            <Radar className="w-4 h-4 mr-2 text-slate-400" />
            <span className="flex-1 font-bold text-slate-200">Battery Echo (LTAMDS-09)</span>
            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>
          </summary>
          <div className="tree-node py-1 text-slate-400">...</div>
        </details>

      </div>
    </div>
  );
}