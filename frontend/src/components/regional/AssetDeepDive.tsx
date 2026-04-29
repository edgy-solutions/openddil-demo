import { useState, useEffect } from 'react';

interface AssetDeepDiveProps {
  assetId: string;
  assetType: string;
  onClose: () => void;
}

export default function AssetDeepDive({ assetId, assetType, onClose }: AssetDeepDiveProps) {
  const [mtbf, setMtbf] = useState(142); // hours
  const [burnRates, setBurnRates] = useState({
    coolant: 1.2, // L/hr
    power: 45, // kW
    hydraulic: 0.8 // L/hr
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setBurnRates(prev => ({
        coolant: prev.coolant + (Math.random() * 0.1 - 0.05),
        power: prev.power + (Math.random() * 2 - 1),
        hydraulic: prev.hydraulic + (Math.random() * 0.05 - 0.025)
      }));
      setMtbf(prev => Math.max(0, prev - 1/3600)); // countdown
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const logs = [
    { date: '2026-04-20', part: 'Coolant Pump', status: 'REPLACED', tech: 'SGT Miller' },
    { date: '2026-03-15', part: 'T/R Module Array', status: 'CALIBRATED', tech: 'CPL Vance' },
    { date: '2026-02-28', part: 'Power Supply Unit', status: 'REPLACED', tech: 'SGT Miller' },
    { date: '2026-01-10', part: 'Filter Assy', status: 'CLEANED', tech: 'PFC Jenkins' },
    { date: '2025-11-05', part: 'Hydraulic Line', status: 'REPLACED', tech: 'SGT Miller' },
  ];

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-2 pb-2">
      <div className="panel p-4 flex justify-between items-center bg-slate-900 border-emerald-500 border-l-4">
        <div>
          <h2 className="text-emerald-400 font-bold text-lg">{assetId}</h2>
          <p className="text-slate-400 text-xs font-mono tracking-widest">{assetType} // DEEP DIVE DIAGNOSTICS</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white bg-slate-800 px-3 py-1 text-xs border border-slate-700">
          CLOSE X-RAY
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="panel p-4 bg-slate-900">
          <h3 className="text-slate-500 text-[10px] mb-2 tracking-widest">PREDICTED MTBF</h3>
          <div className="text-3xl font-rajdhani font-bold text-amber-400">
            {Math.floor(mtbf)}<span className="text-lg text-amber-600">H</span> {Math.floor((mtbf % 1) * 60)}<span className="text-lg text-amber-600">M</span>
          </div>
          <div className="mt-2 text-xs text-slate-400">Critical Failure: Cooling System</div>
        </div>

        <div className="panel p-4 bg-slate-900">
          <h3 className="text-slate-500 text-[10px] mb-2 tracking-widest">CONSUMPTION BURN RATE</h3>
          <div className="flex flex-col gap-1 text-sm font-mono">
            <div className="flex justify-between">
              <span className="text-slate-400">COOLANT</span>
              <span className="text-cyan-400">{burnRates.coolant.toFixed(2)} L/hr</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">POWER</span>
              <span className="text-emerald-400">{burnRates.power.toFixed(1)} kW</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">HYDRAULIC</span>
              <span className="text-rose-400">{burnRates.hydraulic.toFixed(2)} L/hr</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel p-4 flex-1 bg-slate-900 flex flex-col">
        <h3 className="text-slate-500 text-[10px] mb-3 tracking-widest">ACTIONABLE MAINTENANCE LOGS</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-slate-500 border-b border-slate-800">
              <tr>
                <th className="pb-2 font-normal">DATE</th>
                <th className="pb-2 font-normal">PART</th>
                <th className="pb-2 font-normal">ACTION</th>
                <th className="pb-2 font-normal">TECH</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {logs.map((log, i) => (
                <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="py-2">{log.date}</td>
                  <td className="py-2 text-cyan-400">{log.part}</td>
                  <td className="py-2">
                    <span className={`px-1.5 py-0.5 rounded-sm ${log.status === 'REPLACED' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                      {log.status}
                    </span>
                  </td>
                  <td className="py-2 text-slate-500">{log.tech}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
