// =============================================================================
// Header — maintainer-view toolbar
// =============================================================================
// Phase 4c.5: the buffer counter and link status are now REAL — read from
// useEdgeBuffer() (the edge_buffer_status shape the projector's monitor
// writes), not a client-side simulation. The link toggle severs/restores
// the real toxiproxy hq-link proxy. The vestigial second link toggle
// (link2 — never backed by anything) was removed.
import { Laptop, Building2, TrendingUp } from 'lucide-react';
import type { FleetAsset } from '../hooks';
import { useEdgeBuffer } from '../hooks';
import { assetLabel } from '../lib/assetLabel';
import EdgePulldown from './EdgePulldown';

interface HeaderProps {
  link1: boolean;
  setLink1: (v: boolean) => void;
  fleet: FleetAsset[];
  selectedAsset: string;
  setSelectedAsset: (v: string) => void;
  // Phase 6c.2 — per-edge scope. The Maintainer view owns this state
  // (URL-param-synced + reset-on-switch behavior); Header just renders
  // the pulldown and proxies changes back up.
  availableEdges: string[];
  selectedEdge: string | null;
  onSelectEdge: (edgeId: string) => void;
}

// asset_id-first label (assetLabel) so assets with a shared callsign stay
// distinguishable in the picker; platform_variant appended for context.
function pickerLabel(a: FleetAsset): string {
  return a.platform_variant ? `${assetLabel(a)} (${a.platform_variant})` : assetLabel(a);
}

export default function Header({
  link1, setLink1,
  fleet, selectedAsset, setSelectedAsset,
  availableEdges, selectedEdge, onSelectEdge,
}: HeaderProps) {
  const { status } = useEdgeBuffer();
  // Real observed state from the projector's monitor; falls back to the
  // commanded toggle state until the first shape sync arrives.
  const severed = status ? status.hq_link_severed : !link1;
  const lag = status?.bridge_group_lag ?? 0;
  const probeDown = status != null && !status.probe_healthy;
  const linkLabel = probeDown ? 'LINK: PROBE DOWN' : severed ? 'DDIL: LINK SEVERED' : 'EDGE↔HQ: LINK UP';

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        {/* Phase 6c.2: two-level scope chrome — EDGE: [edge-N] › ASSET: [...]
            EdgePulldown is visually prominent (cyan-tinted border, bold label)
            because the maintainer pulldown is the demo-narrative payoff per
            ADR-0023 (FOB transport). The asset picker that follows is the
            FINE selection within the edge's scope. */}
        <EdgePulldown
          available={availableEdges}
          selected={selectedEdge}
          onSelect={onSelectEdge}
        />

        {/* Asset Context Switcher — populated from the edge-scoped fleet
            (useFleetAssetsForEdge in MaintainerApp). The picker contents
            update on edge change; MaintainerApp's re-home effect picks
            the first asset of the new edge unless a deep-link ?asset=
            URL param specifies one in the scoped edge. */}
        <div className="flex flex-col pr-6 border-r border-slate-700">
          <label className="text-[10px] text-slate-400 tracking-wider mb-1">ASSET</label>
          <div className="relative">
            <select
              value={selectedAsset}
              onChange={(e) => setSelectedAsset(e.target.value)}
              className="appearance-none w-64 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 cursor-pointer"
            >
              {fleet.length === 0 && <option value="">— no assets in scope —</option>}
              {fleet.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>{pickerLabel(a)}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
          </div>
        </div>

        {/* THIS NODE highlight: Maintainer view IS the tactical-edge tab,
            so TACTICAL EDGE gets the same emerald THIS-NODE treatment
            HqHeader gives CENTRAL HQ and RegionalHeader gives REGIONAL
            HUB. Without this, the Maintainer tab visually contradicts
            the other two -- the icon stays dim despite being "here". */}
        <div className="flex flex-col items-center text-emerald-400">
          <Laptop className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">TACTICAL EDGE <span className="bg-emerald-500/20 px-1 py-0.5 rounded text-[8px] ml-1">THIS NODE</span></span>
        </div>

        {/* DDIL link — the toggle severs/restores the real toxiproxy hq-link */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${severed ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <div className="relative inline-block w-12 mr-2 align-middle select-none transition duration-200 ease-in mt-1">
            <input
              type="checkbox"
              id="toggle1"
              className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0"
              checked={link1}
              onChange={(e) => setLink1(e.target.checked)}
            />
            <label htmlFor="toggle1" className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${link1 ? 'bg-emerald-500' : 'bg-rose-500'}`}>
              <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${link1 ? 'translate-x-full' : ''}`}></span>
            </label>
          </div>
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${probeDown ? 'text-amber-400' : severed ? 'text-rose-500 glow-rose' : 'text-emerald-400'}`}>
            {linkLabel}
          </span>
        </div>

        {/* CENTRAL HQ is NOT this node on the Maintainer tab -- dim it
            so the THIS-NODE highlight on TACTICAL EDGE reads clearly.
            Same dim-state styling HqHeader uses for TACTICAL EDGE. */}
        <div className="flex flex-col items-center text-slate-500 mr-8">
          <Building2 className="w-6 h-6 mb-1 text-slate-600" />
          <span className="text-[10px] font-bold tracking-wider">CENTRAL HQ</span>
        </div>

        {/* Real edge-buffer depth: bridge-group consumer lag on redpanda-edge */}
        <div className="pl-6 border-l border-slate-700 min-w-[160px]">
          <div className="text-[10px] text-slate-400 tracking-wider">EDGE→HQ BUFFER</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">
              {probeDown ? '—' : lag > 1000 ? (lag / 1000).toFixed(1) + 'K' : lag}
            </span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${lag === 0 ? 'opacity-0' : 'opacity-100'} ${severed ? 'text-rose-500' : 'text-emerald-500 rotate-180'}`} />
          </div>
        </div>
      </div>
    </header>
  );
}
