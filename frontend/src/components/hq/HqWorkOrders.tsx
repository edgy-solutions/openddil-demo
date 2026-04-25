import { Layers } from 'lucide-react';

interface WorkOrder {
  id: string;
  sn: string;
  region: string;
  status: string;
  isNew?: boolean;
}

interface HqWorkOrdersProps {
  wanActive: boolean;
  workOrders: WorkOrder[];
}

export default function HqWorkOrders({ wanActive, workOrders }: HqWorkOrdersProps) {
  return (
    <div className={`panel h-[35%] shrink-0 flex flex-col overflow-hidden p-3 relative transition-colors duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`}>
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <Layers className={`w-4 h-4 mr-2 transition-colors ${wanActive ? 'text-cyan-400' : 'text-rose-500'}`} /> 
        ALCS Enterprise Logistics
      </h2>
      
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead className="text-[10px] text-slate-500 sticky top-0 bg-[#0f172a] shadow-md z-10">
            <tr>
              <th className="pb-2 font-normal w-16">WO #</th>
              <th className="pb-2 font-normal">EQUIP S/N</th>
              <th className="pb-2 font-normal">REGION</th>
              <th className="pb-2 font-normal text-right">STATUS</th>
            </tr>
          </thead>
          <tbody className="text-slate-300 divide-y divide-slate-800">
            {workOrders.map((wo) => (
              <tr 
                key={wo.id} 
                className={`hover:bg-slate-800/50 ${
                  wo.isNew ? 'bg-amber-900/40 border-l-2 border-amber-500 transition-colors duration-1000' : ''
                }`}
              >
                <td className={`py-2 ${wo.isNew ? 'text-amber-400 font-bold' : 'text-slate-500'}`}>{wo.id}</td>
                <td className={wo.isNew ? 'text-amber-400' : ''}>{wo.sn}</td>
                <td className={`text-[10px] ${wo.isNew ? 'text-amber-400' : ''}`}>{wo.region}</td>
                <td className="text-right">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] border ${
                    wo.status === 'AUTO-REQ' 
                      ? 'bg-amber-500/20 text-amber-400 border-amber-500/50 font-bold'
                      : wo.status === 'SHIPPED'
                        ? 'bg-slate-800 text-slate-500 border-slate-700'
                        : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                  }`}>
                    {wo.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}