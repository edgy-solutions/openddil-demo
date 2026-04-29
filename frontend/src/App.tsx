import { useState, useEffect, useMemo } from 'react';
import Header from './components/Header';
import DiagnosticCanvas from './components/DiagnosticCanvas';
import LocalFleetRadar from './components/LocalFleetRadar';
import TelemetryCharts from './components/TelemetryCharts';
import AlertFeed, { type Alert } from './components/AlertFeed';
import Inventory from './components/Inventory';

export interface Asset {
  id: string;
  type: string;
  node_id: string;
}

function App() {
  const [discoveredFleet, setDiscoveredFleet] = useState<Asset[]>([]);
  const [link1, setLink1] = useState(true);
  const [link2, setLink2] = useState(true);
  const [buffer, setBuffer] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [telemetry, setTelemetry] = useState<any>({});
  const [clock, setClock] = useState('');
  const [activeNode, setActiveNode] = useState('FOB-ALPHA');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [faustAlerts, setFaustAlerts] = useState<Alert[]>([]);
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
    const fetchAssets = async () => {
      try {
        const response = await fetch('http://localhost:8000/assets');
        if (response.ok) {
          const data = await response.json();
          const mappedData = data.map((a: any) => ({
            id: a.asset_id,
            type: a.type,
            node_id: a.node_id
          }));
          setDiscoveredFleet(mappedData);
        }
      } catch (error) {
        console.error('Failed to fetch assets:', error);
      }
    };
    
    fetchAssets();
    const interval = setInterval(fetchAssets, 5000);
    return () => clearInterval(interval);
  }, []);

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
      addAlert("UPLINK SEVERED. ISOLATED EDGE MODE ACTIVE.", "warn");
    } else if (link1 && degraded) {
      setDegraded(false);
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
          setFaustAlerts(data || []);
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
          if (data) {
            setTelemetry(data);
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

  const localAssets = useMemo(() => discoveredFleet.filter(asset => asset.node_id === activeNode), [activeNode, discoveredFleet]);

  useEffect(() => {
    if (localAssets.length > 0 && !localAssets.find((a: Asset) => a.id === selectedAssetId)) {
      setSelectedAssetId(localAssets[0].id);
    }
  }, [activeNode, localAssets, selectedAssetId]);

  const selectedAsset = discoveredFleet.find(a => a.id === selectedAssetId) || localAssets[0] || { id: 'UNKNOWN', type: 'RADAR', node_id: activeNode };
  const selectedAssetTelemetry = telemetry[selectedAssetId] || {};

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <Header 
        link1={link1} setLink1={setLink1} 
        link2={link2} setLink2={setLink2} 
        buffer={buffer} 
        discoveredFleet={discoveredFleet}
        selectedAsset={selectedAssetId}
        setSelectedAsset={setSelectedAssetId}
        activeNode={activeNode}
        setActiveNode={setActiveNode}
      />

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden">
        {/* Left Column */}
        <div className="col-span-2 flex flex-col gap-4 overflow-hidden">
          {/* Battery Status Header */}
          <div className="panel flex items-center justify-between shrink-0 p-3">
              <div>
                  <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Engagement - {selectedAsset.id} Status</h2>
                  <div className="flex space-x-4">
                      <div className="flex items-center space-x-2 bg-slate-950 px-3 py-1 border border-slate-800">
                          <span className="text-xs text-slate-500">STATE</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-sm border transition-colors ${degraded ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'}`}>
                            {degraded ? 'DEGRADED' : 'NOMINAL'}
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
            <DiagnosticCanvas assetType={selectedAsset.type} degraded={degraded} coreTemp={selectedAssetTelemetry.core_temp || 32.0} />
            <LocalFleetRadar degraded={degraded} localAssets={localAssets} />
          </div>
        </div>

        {/* Right Column */}
        <div className="col-span-1 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
          <TelemetryCharts assetType={selectedAsset.type} telemetry={selectedAssetTelemetry} degraded={degraded} />
          <AlertFeed alerts={[...faustAlerts, ...alerts]} />
          <Inventory />
        </div>
      </main>
    </div>
  );
}

export default App;