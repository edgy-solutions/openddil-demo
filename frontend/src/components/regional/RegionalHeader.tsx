import React from 'react';
import { Laptop, Server, Building2, TrendingUp } from 'lucide-react';

interface RegionalHeaderProps {
  link1: boolean;
  setLink1: (v: boolean) => void;
  link2: boolean;
  setLink2: (v: boolean) => void;
  buffer: number;
}

export default function RegionalHeader({ link1, setLink1, link2, setLink2, buffer }: RegionalHeaderProps) {
  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
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
            {link1 ? 'LINK 1: ON (EDGE SATCOM)' : 'LINK 1: OFF (EDGE ISOLATED)'}
          </span>
        </div>
        <div className="flex flex-col items-center text-emerald-400">
          <Server className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">REGIONAL HUB <span className="bg-emerald-500/20 px-1 py-0.5 rounded text-[8px] ml-1">THIS NODE</span></span>
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
            {link2 ? 'LINK 2: ON (HQ WAN)' : 'LINK 2: OFF (REGIONAL DDIL)'}
          </span>
        </div>
        <div className="flex flex-col items-center text-slate-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">CENTRAL HQ</span>
        </div>
        <div className="pl-6 border-l border-slate-700 min-w-[150px]">
          <div className="text-[10px] text-slate-400 tracking-wider">REDPANDA REGIONAL BUFFER</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">{buffer > 1000 ? (buffer/1000).toFixed(1) + 'K' : buffer}</span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${buffer === 24 ? 'opacity-0' : 'opacity-100'} ${(!link2) ? 'text-rose-500' : 'text-emerald-500 rotate-180'}`} />
          </div>
        </div>
      </div>
    </header>
  );
}