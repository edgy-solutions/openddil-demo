// =============================================================================
// RegionalApp — the regional view (AOR fleet rollup)
// =============================================================================
// Phase 4c rewrite. Was hardcoded LTAMDS work orders + a battery-tree
// DigitalTwin. Now a real regional dashboard built from the shape hooks:
// an AOR asset list colour-coded by logistics severity, the top
// constraining factors across the fleet, a CM compliance summary, and a
// fleet-wide tactical event feed with a severity filter. Picking an asset
// (here or in the 3D map) opens AssetDeepDive.
//
// The 3D RegionalSustainmentPosture is kept but DEMO_MOCK (synthetic
// theater positions — real geo projection deferred). The link toggles + regional
// buffer are UI demo mechanics — see the Phase 4c checkpoint finding on
// the DDIL link/buffer wiring.
import { useState, useEffect, useMemo } from 'react';
import RegionalHeader from './components/regional/RegionalHeader';
import RegionalSustainmentPosture from './components/regional/RegionalSustainmentPosture';
import WorkOrders from './components/regional/WorkOrders';
import TacticalRuleBuilder from './components/regional/TacticalRuleBuilder';
import AssetDeepDive from './components/regional/AssetDeepDive';
import AlertFeed from './components/AlertFeed';
import {
  useFleetAssets,
  useAllLogisticsStatus,
  useAllCmState,
  useTacticalEvents,
} from './hooks';
import {
  aorAssetList,
  topConstrainingFactors,
  cmComplianceSummary,
  severityHeatClass,
  shortSeverity,
  shortCmStatus,
} from './lib/fleetAggregates';
import { assetCallsign } from './lib/assetLabel';

function AorAssetList({
  fleet, logistics, selectedId, onSelect,
}: {
  fleet: ReturnType<typeof useFleetAssets>['data'];
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo(() => aorAssetList(fleet, logistics), [fleet, logistics]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">AOR Assets ({rows.length})</h2>
      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
        {rows.length === 0 && <div className="text-xs text-slate-500">No assets in the pipeline.</div>}
        {rows.map((r) => {
          const callsign = assetCallsign(r);
          return (
            <button
              key={r.asset_id}
              onClick={() => onSelect(r.asset_id)}
              title={r.asset_id}
              className={`w-full flex items-center justify-between gap-2 text-left text-xs px-2 py-1 border rounded-sm transition-colors ${severityHeatClass(r.severity)} ${selectedId === r.asset_id ? 'ring-1 ring-cyan-400' : ''}`}
            >
              <span className="min-w-0 flex-1">
                {/* asset_id is the distinguishing identifier — callsign is a
                    shared, non-unique value in the sim-a test feed. */}
                <span className="block truncate">{r.asset_id}</span>
                {callsign && <span className="block truncate opacity-60">{callsign}</span>}
              </span>
              <span className="text-[9px] font-bold shrink-0">{shortSeverity(r.severity)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TopFactors({ logistics }: { logistics: ReturnType<typeof useAllLogisticsStatus>['data'] }) {
  const factors = useMemo(() => topConstrainingFactors(logistics, 10), [logistics]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Top Constraining Factors</h2>
      {factors.length === 0 && <div className="text-xs text-slate-500">No constraining factors across the fleet.</div>}
      <div className="space-y-1">
        {factors.map((f) => (
          <div key={f.factor_id} className="flex items-center justify-between text-xs">
            <span className="text-slate-300">{f.factor_id}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-sm border ${severityHeatClass(f.worstSeverity)}`}>
              {f.affectedAssets} asset{f.affectedAssets === 1 ? '' : 's'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CmComplianceSummary({ cm }: { cm: ReturnType<typeof useAllCmState>['data'] }) {
  const buckets = useMemo(() => cmComplianceSummary(cm), [cm]);
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">CM Compliance Summary</h2>
      {buckets.length === 0 && <div className="text-xs text-slate-500">No CM state across the fleet.</div>}
      <div className="space-y-1">
        {buckets.map((b) => (
          <div key={b.status} className="flex items-center justify-between text-xs">
            <span className="text-slate-300">{shortCmStatus(b.status)}</span>
            <span className="text-slate-200 font-bold">{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RegionalApp() {
  // link1 = the DDIL link toggle (severs/restores the real hq-link proxy).
  const [link1, setLink1] = useState(true);
  const [isRuleEditorOpen, setIsRuleEditorOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');

  // Pipeline data — ElectricSQL Shapes.
  const fleet = useFleetAssets();
  const logistics = useAllLogisticsStatus();
  const cm = useAllCmState();
  const events = useTacticalEvents(50);

  // DDIL hq-link sever/restore — disables/enables the real toxiproxy
  // hq-link proxy (see MaintainerApp for why disable, not a toxic). The
  // regional view can drive the sever too; there is one shared hq-link.
  // The real bridge-group lag (RegionalHeader via useEdgeBuffer) reflects it.
  useEffect(() => {
    fetch('/proxies/hq-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: link1 }),
    }).catch((e) => console.error('Toxiproxy error', e));
  }, [link1]);

  const filteredEvents = useMemo(() => {
    if (severityFilter === 'ALL') return events.data;
    return events.data.filter((e) => (e.severity ?? '').toUpperCase().includes(severityFilter));
  }, [events.data, severityFilter]);

  return (
    <div className="font-mono h-screen flex flex-col overflow-hidden bg-slate-950 text-slate-200">
      <RegionalHeader
        link1={link1} setLink1={setLink1}
        setIsRuleEditorOpen={setIsRuleEditorOpen}
      />

      <main className="flex-1 grid grid-cols-3 gap-4 p-4 pt-2 overflow-hidden">
        <RegionalSustainmentPosture
          link1={link1}
          selectedAssetId={selectedAssetId}
          onAssetSelect={(id) => setSelectedAssetId(id)}
        />

        <div className="col-span-1 flex flex-col gap-4 overflow-hidden">
          {selectedAssetId ? (
            <AssetDeepDive assetId={selectedAssetId} onClose={() => setSelectedAssetId(null)} />
          ) : (
            <div className="flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
              <AorAssetList
                fleet={fleet.data}
                logistics={logistics.data}
                selectedId={selectedAssetId}
                onSelect={setSelectedAssetId}
              />
              <TopFactors logistics={logistics.data} />
              <CmComplianceSummary cm={cm.data} />
              <WorkOrders />
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">Severity filter</span>
                  <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 text-slate-300 text-[10px] rounded px-1 py-0.5"
                  >
                    <option value="ALL">All</option>
                    <option value="CRITICAL">Critical</option>
                    <option value="DEGRADED">Degraded</option>
                    <option value="MAJOR">Major</option>
                  </select>
                </div>
                <AlertFeed events={filteredEvents} isLoading={events.isLoading} />
              </div>
            </div>
          )}
        </div>
      </main>

      <TacticalRuleBuilder isOpen={isRuleEditorOpen} onClose={() => setIsRuleEditorOpen(false)} />
    </div>
  );
}
