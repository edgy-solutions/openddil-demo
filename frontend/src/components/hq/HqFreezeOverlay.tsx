import { AlertOctagon } from 'lucide-react';

// HQ has no uplink; this shows only when every link HQ monitors reads down.
export default function HqFreezeOverlay() {
  return (
    <div className="absolute inset-0 z-40 pointer-events-none flex flex-col items-center justify-center pt-20">
      <div className="scanlines absolute inset-0 pointer-events-none z-50 bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,0)_50%,rgba(0,0,0,0.2)_50%,rgba(0,0,0,0.2))] bg-[length:100%_4px]"></div>
      <div className="bg-rose-950/90 border-2 border-rose-500 px-16 py-8 flex flex-col items-center backdrop-blur-md shadow-[0_0_100px_rgba(225,29,72,0.4)] z-50">
        <AlertOctagon className="w-16 h-16 text-rose-500 mb-4 animate-pulse" />
        <h1 className="font-orbitron animate-[pulse-red_2s_infinite] text-5xl font-black text-rose-500 tracking-widest mb-2">SYSTEM FREEZE</h1>
        <p className="text-rose-300 font-mono tracking-widest text-lg bg-rose-900/50 px-4 py-1 border border-rose-500/50">ALL LINKS DOWN • DISPLAYING STALE DATA</p>
      </div>
    </div>
  );
}
