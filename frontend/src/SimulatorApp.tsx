import { useState, useEffect } from 'react';
import { Plus, Trash2, AlertTriangle, CheckCircle2, Activity } from 'lucide-react';

interface Asset {
  asset_id: string;
  type: string;
  node_id: string;
}

export default function SimulatorApp() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [newNodeId, setNewNodeId] = useState('');
  const [newAssetId, setNewAssetId] = useState('');
  const [newAssetType, setNewAssetType] = useState('RADAR');
  const [statusMsg, setStatusMsg] = useState<{text: string, type: 'success' | 'error'} | null>(null);

  const showStatus = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMsg({text, type});
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const fetchAssets = async () => {
    try {
      const response = await fetch('/simulator/assets');
      const data = await response.json();
      setAssets(data);
    } catch (error) {
      console.error('Failed to fetch assets:', error);
    }
  };

  useEffect(() => {
    fetchAssets();
    const interval = setInterval(fetchAssets, 5000);
    return () => clearInterval(interval);
  }, []);

  const addAsset = async () => {
    if (!newAssetId || !newNodeId) return;
    try {
      await fetch('/simulator/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset_id: newAssetId,
          type: newAssetType,
          node_id: newNodeId
        })
      });
      setNewAssetId('');
      fetchAssets();
      showStatus(`Deployed ${newAssetId} to ${newNodeId}`);
    } catch (error) {
      console.error('Failed to add asset:', error);
      showStatus(`Failed to deploy ${newAssetId}`, 'error');
    }
  };

  const removeAsset = async (assetId: string) => {
    try {
      await fetch(`/simulator/assets/${assetId}`, { method: 'DELETE' });
      fetchAssets();
      showStatus(`Removed ${assetId}`);
    } catch (error) {
      console.error('Failed to remove asset:', error);
      showStatus(`Failed to remove ${assetId}`, 'error');
    }
  };

  const triggerAnomaly = async (assetId: string) => {
    try {
      await fetch(`/simulator/trigger-anomaly/${assetId}`, { method: 'POST' });
      showStatus(`Anomaly injected for ${assetId}`);
    } catch (error) {
      console.error('Failed to trigger anomaly:', error);
      showStatus(`Failed to inject anomaly for ${assetId}`, 'error');
    }
  };

  const clearAnomaly = async (assetId: string) => {
    try {
      await fetch(`/simulator/clear-anomaly/${assetId}`, { method: 'POST' });
      showStatus(`Restored ${assetId} to normal`);
    } catch (error) {
      console.error('Failed to clear anomaly:', error);
      showStatus(`Failed to restore ${assetId}`, 'error');
    }
  };

  const nodes = Array.from(new Set(assets.map(a => a.node_id)));

  return (
    <div className="h-full bg-slate-950 p-6 font-mono text-slate-300 overflow-y-auto">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <Activity className="w-8 h-8 text-cyan-500" />
            <div>
              <h1 className="text-2xl font-bold text-white tracking-wider">SIMULATOR CONTROL</h1>
              <p className="text-sm text-slate-500">Fleet &amp; Telemetry Injection Engine</p>
            </div>
          </div>
          {statusMsg && (
            <div className={`px-4 py-2 rounded text-sm font-bold animate-pulse ${statusMsg.type === 'error' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/50' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'}`}>
              {statusMsg.text}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Plus className="w-5 h-5 text-cyan-500" /> Add New Asset
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">NODE ID</label>
                  <input 
                    type="text" 
                    value={newNodeId}
                    onChange={(e) => setNewNodeId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
                    placeholder="e.g. FOB-BRAVO"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">ASSET ID</label>
                  <input 
                    type="text" 
                    value={newAssetId}
                    onChange={(e) => setNewAssetId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
                    placeholder="e.g. RADAR-02"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">ASSET TYPE</label>
                  <select 
                    value={newAssetType}
                    onChange={(e) => setNewAssetType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="RADAR">RADAR (LTAMDS)</option>
                    <option value="LASER_SHORAD">LASER SHORAD (Stryker)</option>
                    <option value="ARTILLERY">ARTILLERY (HIMARS)</option>
                    <option value="QUADRUPED">QUADRUPED (Ghost UGV)</option>
                  </select>
                </div>
                <button 
                  onClick={addAsset}
                  disabled={!newAssetId || !newNodeId}
                  className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  DEPLOY ASSET
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {nodes.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-10 text-center text-slate-500">
                No active nodes in simulation.
              </div>
            ) : (
              nodes.map(nodeId => (
                <div key={nodeId} className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                  <div className="bg-slate-800/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                    <div className="font-bold text-white flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      NODE: {nodeId}
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    {assets.filter(a => a.node_id === nodeId).map(asset => (
                      <div key={asset.asset_id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded p-3">
                        <div>
                          <div className="font-bold text-cyan-400">{asset.asset_id}</div>
                          <div className="text-xs text-slate-500">{asset.type}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => triggerAnomaly(asset.asset_id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 rounded text-xs font-bold transition-colors"
                          >
                            <AlertTriangle className="w-3 h-3" /> INJECT ANOMALY
                          </button>
                          <button 
                            onClick={() => clearAnomaly(asset.asset_id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 rounded text-xs font-bold transition-colors"
                          >
                            <CheckCircle2 className="w-3 h-3" /> RESTORE
                          </button>
                          <div className="w-px h-6 bg-slate-800 mx-1" />
                          <button 
                            onClick={() => removeAsset(asset.asset_id)}
                            className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors"
                            title="Remove Asset"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
