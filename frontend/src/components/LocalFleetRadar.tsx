interface Asset {
  id: string;
  type: string;
  node_id: string;
}

export default function LocalFleetRadar({ degraded, localAssets = [] }: { degraded: boolean, localAssets?: Asset[] }) {
  return (
    <div className="absolute bottom-4 left-4 w-[280px] h-[180px] border border-slate-700 bg-slate-900/90 shadow-2xl z-20 flex flex-col pointer-events-none panel">
      <div className="bg-slate-800 text-[10px] px-2 py-1 text-slate-300 font-bold font-mono border-b border-slate-700 flex justify-between items-center">
        <span className="tracking-wider">LOCAL FLEET RADAR</span>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${degraded ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`}></span>
          <span className={`${degraded ? 'text-amber-400' : 'text-emerald-400'} text-[8px]`}>{degraded ? 'DEGRADED' : 'NOMINAL'}</span>
        </div>
      </div>
      <div className="flex-1 w-full relative overflow-hidden flex items-center justify-center">
        <svg width="100%" height="100%" viewBox="-100 -100 200 200">
          {/* Radar background circles */}
          <circle cx="0" cy="0" r="30" fill="none" stroke="#334155" strokeWidth="1" />
          <circle cx="0" cy="0" r="60" fill="none" stroke="#334155" strokeWidth="1" />
          <circle cx="0" cy="0" r="90" fill="none" stroke="#334155" strokeWidth="1" />
          
          {/* Crosshairs */}
          <line x1="-100" y1="0" x2="100" y2="0" stroke="#334155" strokeWidth="1" />
          <line x1="0" y1="-100" x2="0" y2="100" stroke="#334155" strokeWidth="1" />
          
          {/* Assets */}
          {localAssets.map((asset, i) => {
            const angle = (i / Math.max(1, localAssets.length)) * Math.PI * 2;
            const radius = 60;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            
            // If degraded, mock one as COMM_LOST
            const isCommLost = degraded && i === 0; 
            
            return (
              <g key={asset.id}>
                {!isCommLost && (
                  <line x1="0" y1="0" x2={x} y2={y} stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 2" opacity="0.6" />
                )}
                <circle cx={x} cy={y} r="6" fill={isCommLost ? '#64748b' : '#22d3ee'} />
                <text x={x + 10} y={y + 4} fill={isCommLost ? '#64748b' : '#94a3b8'} fontSize="8" fontFamily="monospace">
                  {asset.id}
                </text>
              </g>
            );
          })}
          
          {/* Center Edge Server */}
          <circle cx="0" cy="0" r="8" fill="#10b981" />
        </svg>
      </div>
    </div>
  );
}
