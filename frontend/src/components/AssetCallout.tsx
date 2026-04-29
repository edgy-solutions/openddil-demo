import { Html } from '@react-three/drei';

interface AssetCalloutProps {
  asset_id: string;
  status: 'NOMINAL' | 'DEGRADED' | 'CRITICAL' | 'COMM_LOST';
  heightOffset?: number;
}

export default function AssetCallout({ asset_id, status, heightOffset = 5 }: AssetCalloutProps) {
  const getColorClasses = () => {
    switch (status) {
      case 'NOMINAL':
        return {
          border: 'border-emerald-500',
          text: 'text-emerald-500',
          bg: 'bg-emerald-500',
        };
      case 'DEGRADED':
        return {
          border: 'border-amber-500',
          text: 'text-amber-500',
          bg: 'bg-amber-500',
        };
      case 'CRITICAL':
        return {
          border: 'border-rose-500',
          text: 'text-rose-500',
          bg: 'bg-rose-500',
        };
      case 'COMM_LOST':
        return {
          border: 'border-slate-500',
          text: 'text-slate-500',
          bg: 'bg-slate-500',
        };
      default:
        return {
          border: 'border-emerald-500',
          text: 'text-emerald-500',
          bg: 'bg-emerald-500',
        };
    }
  };

  const colors = getColorClasses();

  return (
    <Html position={[0, heightOffset, 0]} center zIndexRange={[100, 0]}>
      <div className="flex flex-col items-center pointer-events-none">
        {/* The Horizontal Status Bar */}
        <div className={`flex items-center gap-3 px-3 py-1 bg-slate-950/80 backdrop-blur-sm border border-slate-800 border-l-4 ${colors.border} shadow-lg shadow-black/50`}>
           <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">{asset_id}</span>
           <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${colors.text}`}>
             {status}
           </span>
        </div>
        {/* The Tether Line */}
        <div className={`w-[1px] h-8 ${colors.bg} opacity-70`} style={{ maskImage: 'linear-gradient(to bottom, black, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)' }} />
      </div>
    </Html>
  );
}