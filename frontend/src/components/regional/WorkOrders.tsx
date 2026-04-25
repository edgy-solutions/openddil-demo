import { ClipboardList, Lock } from 'lucide-react';

export interface WorkOrder {
  id: string;
  sn: string;
  part: string;
  status: string;
  isNew?: boolean;
}

interface WorkOrdersProps {
  link2: boolean;
  workOrders: WorkOrder[];
}

export default function WorkOrders({ link2, workOrders }: WorkOrdersProps) {
  return (
    <div className="panel h-64 shrink-0 flex flex-col overflow-hidden p-3 relative">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center shrink-0 border-b border-slate-700 pb-2">
        <ClipboardList className="w-4 h-4 mr-2 text-cyan-400" /> Regional Work Orders
      </h2>
      
      {/* System Freeze Overlay */}
      {!link2 && (
        <div className="absolute inset-0 bg-rose-950/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center border-2 border-rose-500 mt-12 mx-3 mb-3">
          <Lock className="w-8 h-8 text-rose-500 mb-2" />
          <span className="font-bold text-rose-400 tracking-widest text-sm">SYSTEM FREEZE</span>
          <span className="text-[10px] text-rose-300 mt-1">WAITING FOR HQ WAN...</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead className="text-[10px] text-slate-500 sticky top-0 bg-[#0f172a] shadow-md z-10">
            <tr>
              <th className="pb-2 font-normal">WO NUMBER</th>
              <th className="pb-2 font-normal">S/N</th>
              <th className="pb-2 font-normal">REQUIRED PART</th>
              <th className="pb-2 font-normal text-right">STATUS</th>
            </tr>
          </thead>
          <tbody className="text-slate-300 divide-y divide-slate-800">
            {workOrders.map(wo => (
              <tr key={wo.id} className={`hover:bg-slate-800/50 transition-colors ${wo.isNew ? 'bg-amber-900/20' : ''}`}>
                <td className={`py-2 ${wo.isNew ? 'text-amber-400' : ''}`}>{wo.id}</td>
                <td className={wo.isNew ? 'text-amber-400' : ''}>{wo.sn}</td>
                <td className={wo.isNew ? 'text-amber-400' : ''}>{wo.part}</td>
                <td className="text-right">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] border ${
                    wo.status === 'COMPLETED' 
                      ? 'bg-slate-800 text-slate-400 border-slate-700' 
                      : 'bg-amber-500/20 text-amber-400 border-amber-500/50'
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