import { Package } from 'lucide-react';

export default function Inventory() {
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
          <Package className="w-4 h-4 mr-2" /> Local FOB Inventory
      </h2>
      <div className="space-y-3">
          <div>
              <div className="flex justify-between text-xs mb-1 text-slate-300">
                  <span>Coolant Pumps</span>
                  <span>0</span>
              </div>
              <div className="w-full bg-slate-800 h-2">
                  <div className="bg-rose-500 h-2" style={{ width: '2%' }}></div>
              </div>
          </div>
          <div>
              <div className="flex justify-between text-xs mb-1 text-slate-300">
                  <span>T/R Modules</span>
                  <span>14</span>
              </div>
              <div className="w-full bg-slate-800 h-2">
                  <div className="bg-slate-500 h-2" style={{ width: '45%' }}></div>
              </div>
          </div>
      </div>
    </div>
  );
}