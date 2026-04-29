import { useState, useEffect } from 'react';
import RegionalHeader from './components/regional/RegionalHeader';
import RegionalBattleView from './components/regional/RegionalBattleView';
import DigitalTwin from './components/regional/DigitalTwin';
import WorkOrders, { type WorkOrder } from './components/regional/WorkOrders';
import TacticalRuleBuilder from './components/regional/TacticalRuleBuilder';
import AssetDeepDive from './components/regional/AssetDeepDive';

const INITIAL_WORK_ORDERS: WorkOrder[] = [
  { id: 'WO-8810', sn: 'LTAMDS-04', part: 'Coolant Pump', status: 'COMPLETED' },
  { id: 'WO-8809', sn: 'LTAMDS-02', part: 'T/R Module', status: 'COMPLETED' },
  { id: 'WO-8807', sn: 'LTAMDS-07', part: 'Power Supply', status: 'COMPLETED' },
  { id: 'WO-8805', sn: 'LTAMDS-09', part: 'Filter Assy', status: 'COMPLETED' },
];

export default function RegionalApp() {
  const [link1, setLink1] = useState(true);
  const [link2, setLink2] = useState(true);
  const [buffer, setBuffer] = useState(24);
  const [degradedBravo, setDegradedBravo] = useState(false);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(INITIAL_WORK_ORDERS);
  const [isRuleEditorOpen, setIsRuleEditorOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<{id: string, type: string} | null>(null);

  // Link 1 (Edge to Region) logic
  useEffect(() => {
    if (!link1) {
      setDegradedBravo(true);
    } else {
      setDegradedBravo(false);
    }
  }, [link1]);

  // Link 2 (Region to HQ) logic
  useEffect(() => {
    if (link2 && buffer > 100) {
      // Simulate instantly receiving a backlog of WOs when connection restores
      const newWO: WorkOrder = {
        id: 'WO-9942',
        sn: 'LTAMDS-04',
        part: 'Coolant Pump',
        status: 'AUTO-REQ',
        isNew: true
      };
      setWorkOrders(prev => [newWO, ...prev]);
      
      // Remove highlight after 2 seconds
      setTimeout(() => {
        setWorkOrders(prev => prev.map(wo => wo.id === 'WO-9942' ? { ...wo, isNew: false } : wo));
      }, 2000);
    }
  }, [link2]); // Removed buffer from dependency to only trigger on link2 restore

  // Buffer Loop
  useEffect(() => {
    const interval = setInterval(() => {
      setBuffer(prev => {
        if (!link2) {
          // If cut off from HQ, regional buffer grows rapidly
          return prev + Math.floor(Math.random() * 80) + 20;
        } else if (prev > 24) {
          // Drain buffer when connected
          return Math.max(24, prev - Math.floor(prev * 0.3) - 50);
        } else {
          // Idle fluctuation
          return 24 + Math.floor(Math.random() * 5);
        }
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [link2]);

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <RegionalHeader 
        link1={link1} 
        setLink1={setLink1} 
        link2={link2} 
        setLink2={setLink2} 
        buffer={buffer} 
        setIsRuleEditorOpen={setIsRuleEditorOpen}
      />

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden">
        <RegionalBattleView 
          link1={link1} 
          selectedAssetId={selectedAsset?.id || null} 
          onAssetSelect={(id, type) => setSelectedAsset({id, type})} 
        />

        <div className="col-span-1 flex flex-col gap-4 overflow-hidden">
          {selectedAsset ? (
            <AssetDeepDive 
              assetId={selectedAsset.id} 
              assetType={selectedAsset.type} 
              onClose={() => setSelectedAsset(null)} 
            />
          ) : (
            <>
              <DigitalTwin degradedBravo={degradedBravo} />
              <WorkOrders link2={link2} workOrders={workOrders} />
            </>
          )}
        </div>
      </main>

      <TacticalRuleBuilder isOpen={isRuleEditorOpen} onClose={() => setIsRuleEditorOpen(false)} />
    </div>
  );
}