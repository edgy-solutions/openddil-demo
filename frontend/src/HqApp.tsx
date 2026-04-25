import { useState, useEffect, useRef } from 'react';
import HqHeader from './components/hq/HqHeader';
import HqBattleView from './components/hq/HqBattleView';
import HqDigitalTwin from './components/hq/HqDigitalTwin';
import HqWorkOrders from './components/hq/HqWorkOrders';
import { AlertOctagon } from 'lucide-react';

interface WorkOrder {
  id: string;
  sn: string;
  region: string;
  status: string;
  isNew?: boolean;
}

const INITIAL_WORK_ORDERS: WorkOrder[] = [
  { id: 'WO-8810', sn: 'LTAMDS-04', region: 'EUCOM-MED', status: 'SHIPPED' },
  { id: 'WO-8791', sn: 'LTAMDS-12', region: 'PACOM-JP', status: 'SHIPPED' },
  { id: 'WO-8755', sn: 'LTAMDS-02', region: 'EUCOM-BALT', status: 'DELIVERED' },
  { id: 'WO-8702', sn: 'LTAMDS-09', region: 'CENTCOM', status: 'DELIVERED' },
];

export default function HqApp() {
  const [wanActive, setWanActive] = useState(true);
  const [buffer, setBuffer] = useState(0);
  const [bufferTrend, setBufferTrend] = useState<'up' | 'down' | 'none'>('none');
  const [threatCount, setThreatCount] = useState(42);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(INITIAL_WORK_ORDERS);
  
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  // The Toxiproxy God Switch
  const toggleWan = async (active: boolean) => {
    setWanActive(active);
    
    try {
      if (!active) {
        // Sever the connection
        await fetch('/proxies/hq-link/toxics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: "hq_timeout",
            type: "timeout",
            stream: "downstream",
            toxicity: 1.0,
            attributes: { timeout: 0 }
          })
        });
      } else {
        // Restore the connection
        await fetch('/proxies/hq-link/toxics/hq_timeout', {
          method: 'DELETE'
        });
        
        // Simulate Flush of queued data
        if (bufferRef.current > 0) {
          fastForwardSimulation();
        }
      }
    } catch (err) {
      console.error("Toxiproxy Error:", err);
      // Fallback for simulation if Toxiproxy is not running
      if (active && bufferRef.current > 0) {
        fastForwardSimulation();
      }
    }
  };

  const fastForwardSimulation = () => {
    // Animate instantly injecting auto-requisitioned work orders
    const newWo: WorkOrder = {
      id: 'WO-9942',
      sn: 'LTAMDS-04',
      region: 'EUCOM-MED',
      status: 'AUTO-REQ',
      isNew: true
    };
    
    setWorkOrders(prev => [newWo, ...prev]);
    
    // Remove highlight after a bit
    setTimeout(() => {
      setWorkOrders(prev => prev.map(wo => 
        wo.id === 'WO-9942' ? { ...wo, isNew: false } : wo
      ));
    }, 3000);
    
    // Jump threat count
    setThreatCount(prev => prev + Math.floor(Math.random() * 15));
  };

  // Buffer & Data Loop
  useEffect(() => {
    const interval = setInterval(() => {
      setBuffer(prev => {
        if (!wanActive) {
          // Network Severed: Buffer queues heavily at the edge
          const newBuffer = prev + Math.floor(Math.random() * 850) + 200;
          setBufferTrend('up');
          return newBuffer;
        } else {
          // Network Active: Buffer drains, live data ticks
          if (prev > 0) {
            const newBuffer = Math.max(0, prev - Math.floor(prev * 0.4) - 1500);
            setBufferTrend('down');
            return newBuffer;
          } else {
            setBufferTrend('none');
            
            // Normal threat fluctuation
            if (Math.random() > 0.7) {
              setThreatCount(curr => curr + (Math.random() > 0.5 ? 1 : -1));
            }
            return 0;
          }
        }
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [wanActive]);

  return (
    <div className={`font-mono h-screen flex flex-col overflow-hidden transition-colors duration-500 ${!wanActive ? 'freeze-active' : ''}`}>
      <HqHeader 
        wanActive={wanActive} 
        setWanActive={toggleWan} 
        buffer={buffer} 
        bufferTrend={bufferTrend} 
      />

      {/* Global Freeze Overlay Container */}
      {!wanActive && (
        <div className="absolute inset-0 z-40 pointer-events-none flex flex-col items-center justify-center pt-20">
          <div className="scanlines absolute inset-0 pointer-events-none z-50 bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,0)_50%,rgba(0,0,0,0.2)_50%,rgba(0,0,0,0.2))] bg-[length:100%_4px]"></div>
          <div className="bg-rose-950/90 border-2 border-rose-500 px-16 py-8 flex flex-col items-center backdrop-blur-md shadow-[0_0_100px_rgba(225,29,72,0.4)] z-50">
            <AlertOctagon className="w-16 h-16 text-rose-500 mb-4 animate-pulse" />
            <h1 className="font-orbitron animate-[pulse-red_2s_infinite] text-5xl font-black text-rose-500 tracking-widest mb-2">SYSTEM FREEZE</h1>
            <p className="text-rose-300 font-mono tracking-widest text-lg bg-rose-900/50 px-4 py-1 border border-rose-500/50">WAN UPLINK SEVERED • DISPLAYING STALE DATA</p>
          </div>
        </div>
      )}

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden relative z-0">
        <HqBattleView 
          wanActive={wanActive} 
          threatCount={threatCount} 
        />

        <div className="col-span-1 flex flex-col gap-4 overflow-hidden">
          <HqDigitalTwin wanActive={wanActive} />
          <HqWorkOrders wanActive={wanActive} workOrders={workOrders} />
        </div>
      </main>
    </div>
  );
}