import { useState, useEffect } from 'react';
import { Settings, Activity, Wifi, Zap, ShieldAlert } from 'lucide-react';

export default function ControllerApp() {
  const [bandwidth, setBandwidth] = useState<number>(1250); // KB/s (1250 = 10 Mbps)
  const [jitter, setJitter] = useState<number>(0); // ms
  const [stutter, setStutter] = useState<boolean>(false);

  const applyToxic = async (toxicName: string, type: string, attributes: any) => {
    try {
      // Always try to delete first to avoid conflicts
      await fetch(`http://localhost:8475/proxies/hq-link/toxics/${toxicName}`, { method: 'DELETE' }).catch(() => {});
      
      if (attributes !== null) {
        await fetch(`http://localhost:8475/proxies/hq-link/toxics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: toxicName,
            type: type,
            stream: "downstream",
            toxicity: 1.0,
            attributes: attributes
          })
        });
      }
    } catch (e) {
      console.error(`Failed to apply toxic ${toxicName}:`, e);
    }
  };

  // Debounce API calls for sliders
  useEffect(() => {
    const timer = setTimeout(() => {
      if (bandwidth >= 1250) {
        applyToxic('bw_limit', 'bandwidth', null);
      } else {
        applyToxic('bw_limit', 'bandwidth', { rate: bandwidth });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [bandwidth]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (jitter === 0) {
        applyToxic('latency_jitter', 'latency', null);
      } else {
        applyToxic('latency_jitter', 'latency', { latency: jitter, jitter: Math.floor(jitter / 2) });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [jitter]);

  useEffect(() => {
    if (stutter) {
      applyToxic('stutter', 'slicer', { average_size: 1024, size_variation: 512, delay: 200000 });
    } else {
      applyToxic('stutter', 'slicer', null);
    }
  }, [stutter]);

  // Formatting helpers
  const formatBandwidth = (kbps: number) => {
    if (kbps >= 1250) return "10 Mbps (UNLIMITED)";
    if (kbps < 100) return `${(kbps * 8).toFixed(0)} kbps`;
    return `${(kbps / 125).toFixed(1)} Mbps`;
  };

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-300">
      <header className="panel flex items-center justify-between p-4 m-4 shrink-0 z-10 border-b-2 border-b-slate-700">
        <div className="flex items-center space-x-4">
          <Settings className="w-8 h-8 text-cyan-400" />
          <div>
            <h1 className="text-xl font-bold font-orbitron tracking-widest text-cyan-400">DDIL DEGRADATION SIMULATOR</h1>
            <p className="text-xs text-slate-500 tracking-widest">TOXIPROXY CONTROL INTERFACE</p>
          </div>
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 tracking-widest">TARGET PROXY</span>
            <span className="text-sm font-bold text-slate-200">hq-link (8474)</span>
          </div>
          <Activity className="w-6 h-6 text-emerald-500 animate-pulse" />
        </div>
      </header>

      <main className="flex-1 p-4 overflow-y-auto">
        <div className="max-w-4xl mx-auto space-y-8">
          
          {/* Bandwidth Control */}
          <div className="panel p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <Wifi className={`w-6 h-6 ${bandwidth < 1250 ? 'text-amber-500' : 'text-emerald-500'}`} />
                <h2 className="text-lg font-bold tracking-widest text-slate-200">BANDWIDTH LIMITER</h2>
              </div>
              <div className={`px-3 py-1 rounded border font-bold ${bandwidth < 1250 ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                {formatBandwidth(bandwidth)}
              </div>
            </div>
            
            <div className="px-4">
              <input 
                type="range" 
                min="6" 
                max="1250" 
                step="1"
                value={bandwidth}
                onChange={(e) => setBandwidth(parseInt(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-2 font-bold">
                <span>50 kbps (SEVERE)</span>
                <span>10 Mbps (NOMINAL)</span>
              </div>
            </div>
          </div>

          {/* Jitter Control */}
          <div className="panel p-6 border border-slate-700">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <Activity className={`w-6 h-6 ${jitter > 0 ? 'text-rose-500' : 'text-emerald-500'}`} />
                <h2 className="text-lg font-bold tracking-widest text-slate-200">LATENCY &amp; JITTER</h2>
              </div>
              <div className={`px-3 py-1 rounded border font-bold ${jitter > 0 ? 'bg-rose-500/20 text-rose-400 border-rose-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                {jitter} ms
              </div>
            </div>
            
            <div className="px-4">
              <input 
                type="range" 
                min="0" 
                max="1000" 
                step="10"
                value={jitter}
                onChange={(e) => setJitter(parseInt(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-2 font-bold">
                <span>0 ms (NOMINAL)</span>
                <span>1000 ms (SEVERE)</span>
              </div>
            </div>
          </div>

          {/* Stutter Control */}
          <div className="panel p-6 border border-slate-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <Zap className={`w-6 h-6 ${stutter ? 'text-amber-500' : 'text-slate-500'}`} />
                <div>
                  <h2 className="text-lg font-bold tracking-widest text-slate-200">PACKET SLICER (STUTTER)</h2>
                  <p className="text-xs text-slate-500 mt-1">Slices data into erratic chunks with micro-delays</p>
                </div>
              </div>
              
              <div className="relative inline-block w-16 align-middle select-none transition duration-200 ease-in">
                <input 
                  type="checkbox" 
                  id="stutter-toggle" 
                  checked={stutter}
                  onChange={(e) => setStutter(e.target.checked)}
                  className="toggle-checkbox absolute block w-8 h-8 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0" 
                />
                <label 
                  htmlFor="stutter-toggle" 
                  className={`toggle-label block overflow-hidden h-8 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${stutter ? 'bg-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.4)]' : 'bg-slate-700'}`}
                >
                  <span className={`toggle-dot absolute left-0 block w-8 h-8 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${stutter ? 'transform translate-x-full' : ''}`}></span>
                </label>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800 p-4 rounded flex items-start space-x-3">
            <ShieldAlert className="w-5 h-5 text-cyan-500 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400 leading-relaxed">
              <strong className="text-slate-200">INSTRUCTIONS:</strong> Use these controls to simulate DDIL environments in real-time. 
              Open the Edge and HQ dashboards in separate windows. As you aggressively lower bandwidth and increase jitter, 
              observe the HQ dashboard lag and eventually freeze, while the Edge dashboard remains fully responsive and autonomous.
            </p>
          </div>

        </div>
      </main>
    </div>
  );
}