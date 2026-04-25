import React, { useState } from 'react';
import App from './App';
import RegionalApp from './RegionalApp';
import HqApp from './HqApp';
import ControllerApp from './ControllerApp';
import { Laptop, Server, Building2, SlidersHorizontal } from 'lucide-react';

function Root() {
  const [view, setView] = useState<'edge' | 'regional' | 'hq' | 'controller'>('edge');

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-300 overflow-hidden font-mono">
      {/* Dev Navigation Bar (Not part of the actual UI mockups, just for switching) */}
      <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-50 relative">
        <div className="flex items-center gap-2 text-cyan-500 font-orbitron font-bold tracking-widest text-sm">
          <span className="text-white">OpenDDIL</span> DEMO
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setView('edge')}
            className={`px-3 py-1 flex items-center gap-2 text-xs font-bold transition-colors ${view === 'edge' ? 'bg-slate-800 text-white border border-slate-600' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <Laptop className="w-3 h-3" /> EDGE
          </button>
          <button 
            onClick={() => setView('regional')}
            className={`px-3 py-1 flex items-center gap-2 text-xs font-bold transition-colors ${view === 'regional' ? 'bg-slate-800 text-white border border-slate-600' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <Server className="w-3 h-3" /> REGIONAL
          </button>
          <button 
            onClick={() => setView('hq')}
            className={`px-3 py-1 flex items-center gap-2 text-xs font-bold transition-colors ${view === 'hq' ? 'bg-slate-800 text-white border border-slate-600' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <Building2 className="w-3 h-3" /> HQ
          </button>
          <button 
            onClick={() => setView('controller')}
            className={`px-3 py-1 flex items-center gap-2 text-xs font-bold transition-colors ${view === 'controller' ? 'bg-slate-800 text-white border border-slate-600' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <SlidersHorizontal className="w-3 h-3" /> DDIL CONTROLLER
          </button>
        </div>
      </div>

      {/* Main View Container */}
      <div className="flex-1 relative">
        {view === 'edge' && <App />}
        {view === 'regional' && <RegionalApp />}
        {view === 'hq' && <HqApp />}
        {view === 'controller' && <ControllerApp />}
      </div>
    </div>
  );
}

export default Root;