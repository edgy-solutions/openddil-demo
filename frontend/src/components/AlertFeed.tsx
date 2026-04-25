import React from 'react';
import { AlertTriangle } from 'lucide-react';

export interface Alert {
  id: string;
  msg: string;
  type: 'info' | 'warn' | 'crit';
  time: string;
}

export default function AlertFeed({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="panel flex-1 flex flex-col min-h-[150px] p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2 flex items-center">
          <AlertTriangle className="w-4 h-4 mr-2" /> Faust/Restate Alert Feed
      </h2>
      <div className="flex-1 overflow-y-auto space-y-2 text-xs font-mono pr-2">
        {alerts.map(alert => {
          let colors = "border-slate-500 bg-slate-800/50 text-slate-300";
          if (alert.type === "warn") colors = "border-amber-500 bg-amber-500/10 text-amber-400";
          if (alert.type === "crit") colors = "border-rose-500 bg-rose-500/10 text-rose-400";
          return (
            <div key={alert.id} className={`p-2 border-l-2 text-xs mb-2 transition-all ${colors}`}>
              <span className="opacity-50 mr-2">[{alert.time}]</span> {alert.msg}
            </div>
          );
        })}
      </div>
    </div>
  );
}