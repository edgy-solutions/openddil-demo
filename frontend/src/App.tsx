import { useState, useEffect } from 'react';
import Header from './components/Header';
import LtamdsView from './components/LtamdsView';
import BattleView from './components/BattleView';
import TelemetryCharts from './components/TelemetryCharts';
import AlertFeed, { type Alert } from './components/AlertFeed';
import Inventory from './components/Inventory';

function App() {
  const [link1, setLink1] = useState(true);
  const [link2, setLink2] = useState(true);
  const [buffer, setBuffer] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [thermal, setThermal] = useState(32.0);
  const [pressure, setPressure] = useState(120.0);
  const [radarColor, setRadarColor] = useState('#10b981');
  const [clock, setClock] = useState('');
  const [alerts, setAlerts] = useState<Alert[]>([
    { id: 'init', msg: 'SYSTEM INITIALIZED. AWAITING TELEMETRY.', type: 'info', time: new Date().toLocaleTimeString('en-US', { hour12: false }) }
  ]);

  const addAlert = (msg: string, type: 'info' | 'warn' | 'crit') => {
    setAlerts(prev => [{
      id: Math.random().toString(),
      msg,
      type,
      time: new Date().toLocaleTimeString('en-US', { hour12: false })
    }, ...prev]);
  };

  useEffect(() => {
    const handleToxiproxy = async (enabled: boolean) => {
      try {
        if (!enabled) {
          await fetch('/proxies/hq-link/toxics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'timeout_down',
              type: 'timeout',
              stream: 'downstream',
              toxicity: 1.0,
              attributes: { timeout: 0 }
            })
          });
        } else {
          await fetch('/proxies/hq-link/toxics/timeout_down', {
            method: 'DELETE'
          });
        }
      } catch (e) {
        console.error('Toxiproxy error', e);
      }
    };
    handleToxiproxy(link1);
  }, [link1]);

  useEffect(() => {
    if (!link1 && !degraded) {
      setDegraded(true);
      setRadarColor('#f59e0b');
      addAlert("UPLINK SEVERED. ISOLATED EDGE MODE ACTIVE.", "warn");
    } else if (link1 && degraded) {
      setDegraded(false);
      setRadarColor('#10b981');
      addAlert("UPLINK RESTORED. FLUSHING BUFFER TO HQ.", "info");
      setTimeout(() => addAlert("SYSTEM NOMINAL. FULL POWER RESTORED.", "info"), 1500);
    }
  }, [link1, degraded]);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const res = await fetch('/api/alerts');
        if (res.ok) {
          const data = await res.json();
          if (data && data.length > 0) {
            setAlerts(prev => {
              const existingIds = new Set(prev.map(a => a.id));
              const newAlerts = data.filter((a: Alert) => !existingIds.has(a.id));
              if (newAlerts.length > 0) {
                return [...newAlerts.reverse(), ...prev];
              }
              return prev;
            });
          }
        }
      } catch (e) {
        // Ignore fetch errors
      }
    };

    const fetchTelemetry = async () => {
      try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
          const data = await res.json();
          if (data && data.thermal && data.pressure) {
            setThermal(data.thermal);
            setPressure(data.pressure);
          }
        }
      } catch (e) {
        // Ignore fetch errors
      }
    };

    const interval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
      fetchAlerts();
      fetchTelemetry();
      
      setBuffer(prev => {
        if (!link1 || !link2) {
          return prev + Math.floor(Math.random() * 45) + 10;
        } else if (prev > 0) {
          return Math.max(0, prev - Math.floor(prev * 0.2) - 100);
        }
        return prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, [link1, link2, degraded]);

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <Header link1={link1} setLink1={setLink1} link2={link2} setLink2={setLink2} buffer={buffer} />

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden">
        {/* Left Column */}
        <div className="col-span-2 flex flex-col gap-4 overflow-hidden">
          {/* Battery Status Header */}
          <div className="panel flex items-center justify-between shrink-0 p-3">
              <div>
                  <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Engagement - LTAMDS Radar Status</h2>
                  <div className="flex space-x-4">
                      <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                          <span className="text-xs text-slate-500">STATE</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${degraded ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                            {degraded ? 'DEGRADED_SECTOR' : 'FULL_COVERAGE'}
                          </span>
                      </div>
                      <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                          <span className="text-xs text-slate-500">PWR</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${degraded ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                            {degraded ? '85%' : '100%'}
                          </span>
                      </div>
                  </div>
              </div>
              <div className="text-right">
                  <div className="text-xs text-slate-500 mb-1">LOCAL TIME</div>
                  <div className="text-xl font-bold text-slate-200">{clock}</div>
              </div>
          </div>

          <div className="panel flex-1 relative overflow-hidden font-rajdhani font-semibold">
            <LtamdsView degraded={degraded} coreTemp={thermal} />
            <BattleView degraded={degraded} radarColor={radarColor} />
          </div>
        </div>

        {/* Right Column */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <TelemetryCharts thermal={thermal} pressure={pressure} degraded={degraded} />
          <AlertFeed alerts={alerts} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default App;