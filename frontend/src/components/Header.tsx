// =============================================================================
// Header — maintainer-view toolbar
// =============================================================================
// Phase 4c.5: the buffer counter and link status are now REAL — read from
// useEdgeBuffer() (the edge_buffer_status shape the projector's monitor
// writes), not a client-side simulation. The link toggle severs/restores
// the real toxiproxy hq-link proxy. The vestigial second link toggle
// (link2 — never backed by anything) was removed.
import { Laptop, Building2, TrendingUp } from 'lucide-react';
import { ThisNodeBadge } from '../lib/thisNode';
import type { FleetAsset, FleetTierMap } from '../hooks';
import { useEdgeBuffer } from '../hooks';
import { assetLabel } from '../lib/assetLabel';
import {
  TIER_ORDER,
  tierLabel,
  tierShortCode,
  type AssetTier,
} from '../lib/assetTier';
import EdgePulldown from './EdgePulldown';
import IdentityBadge from './releasability/IdentityBadge';
import NationLegend from './releasability/NationLegend';
import { useSession } from '../hooks/useSession';

// Per-tier styling for the inline count chips above the ASSET label.
// Live tiers (ACTIVE / DEGRADED) use the live-fleet palette; silent
// tiers use the matching slate/amber/rose tone the operator sees on
// the 3D scene's ring outlines, so the badge reads as a tiny
// "what's outside the live fleet right now" summary.
const TIER_CHIP_CLASS: Record<AssetTier, string> = {
  ACTIVE:    'text-emerald-300',
  DEGRADED:  'text-amber-300',
  STALE:     'text-slate-400',
  COMM_LOST: 'text-amber-500',
  LOST:      'text-rose-400',
};

function TierCountChips({ fleet, tiers }: {
  fleet: FleetAsset[];
  tiers: FleetTierMap | undefined;
}) {
  // No tier data yet (cold start) -> render nothing rather than five
  // zeros that will pop on first refresh.
  if (!tiers || fleet.length === 0) return null;

  const counts: Record<AssetTier, number> = {
    ACTIVE: 0, DEGRADED: 0, STALE: 0, COMM_LOST: 0, LOST: 0,
  };
  for (const a of fleet) {
    const t = tiers.get(a.asset_id) ?? 'ACTIVE';
    counts[t]++;
  }

  // Best-to-worst left-to-right so the eye lands on the live count
  // first. ACTIVE is always shown (even at 0 -- "no live assets" is
  // a signal); other tiers only appear when non-zero so the strip
  // stays narrow in the common case.
  const visible = TIER_ORDER.slice().reverse().filter(
    (t) => t === 'ACTIVE' || counts[t] > 0,
  );

  return (
    <span className="flex items-center gap-2 font-mono text-[10px] tracking-wider">
      {visible.map((t, i) => (
        <span key={t} className={TIER_CHIP_CLASS[t]} title={tierLabel(t)}>
          {i > 0 && <span className="text-slate-600 mr-2">·</span>}
          {tierShortCode(t)} {counts[t]}
        </span>
      ))}
    </span>
  );
}

interface HeaderProps {
  link1: boolean;
  setLink1: (v: boolean) => void;
  fleet: FleetAsset[];
  /** Per-asset tier map (Phase 4 liveness). Drives the picker option
   *  suffix + dim styling. Optional so existing callers (tests, future
   *  alt-mounts) don't have to plumb it through; absence = no suffix
   *  + no dimming. */
  fleetTiers?: FleetTierMap;
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
// Non-live tier (STALE / COMM_LOST / LOST) suffixed in brackets so the
// operator sees at a glance which assets they're navigating into are
// silent. ACTIVE / DEGRADED render bare; tier label only appears when
// something noteworthy is wrong.
function pickerLabel(a: FleetAsset, tier: AssetTier | undefined): string {
  const base = a.platform_variant
    ? `${assetLabel(a)} (${a.platform_variant})`
    : assetLabel(a);
  if (!tier || tier === 'ACTIVE' || tier === 'DEGRADED') return base;
  return `${base} — ${tierLabel(tier).toUpperCase()}`;
}

export default function Header({
  link1, setLink1,
  fleet, fleetTiers, selectedAsset, setSelectedAsset,
  availableEdges, selectedEdge, onSelectEdge,
}: HeaderProps) {
  const { status } = useEdgeBuffer();
  // PRESENTATION ONLY. `session.nations` decides which legend keys are worth
  // showing and whether an asset is marked "released to you"; it filters
  // nothing. The rows below have already been filtered by the gateway
  // (ADR-0029 §1), and a second filter here would be a second authorization
  // decision that nobody reviewed.
  const session = useSession();
  // Real observed state from the projector's monitor; falls back to the
  // commanded toggle state until the first shape sync arrives.
  const severed = status ? status.hq_link_severed : !link1;
  const lag = status?.bridge_group_lag ?? 0;
  const probeDown = status != null && !status.probe_healthy;
  const linkLabel = probeDown ? 'LINK: PROBE DOWN' : severed ? 'DDIL: LINK SEVERED' : 'EDGE↔HQ: LINK UP';

  return (
    <header className="panel flex flex-col p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      {/* WHOSE SCREEN IS THIS. Placed above everything else, because the
          answer changes what every number below it means — and in a
          side-by-side demo it is the only thing distinguishing two windows
          that are otherwise identical. */}
      <div className="mb-2 flex w-full max-w-6xl mx-auto items-center justify-between gap-4">
        <NationLegend assets={fleet} viewerNations={session.nations} />
        <IdentityBadge />
      </div>
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
          {/* Title row: ASSET label on the left, tier-count chips
              right-justified above the pulldown -- compact summary
              of fleet liveness without taking a separate header
              strip. Hidden on cold start (no tier data yet) so the
              user doesn't see five zeros pop in. */}
          <div className="flex items-baseline justify-between mb-1 w-64">
            <label className="text-[10px] text-slate-400 tracking-wider">ASSET</label>
            <TierCountChips fleet={fleet} tiers={fleetTiers} />
          </div>
          <div className="relative">
            <select
              value={selectedAsset}
              onChange={(e) => setSelectedAsset(e.target.value)}
              className="appearance-none w-64 bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 cursor-pointer"
            >
              {fleet.length === 0 && <option value="">— no assets in scope —</option>}
              {fleet.map((a) => {
                const tier = fleetTiers?.get(a.asset_id);
                // Non-live tiers dim the option text so the picker
                // reads as "live fleet first, silent assets visibly
                // demoted". Browser <option> styling is limited
                // (color works in most chromium-derivative browsers
                // even though spec-wise it's optional) -- the
                // text-content suffix carries the same info either
                // way for accessibility.
                const dim = tier && tier !== 'ACTIVE' && tier !== 'DEGRADED';
                return (
                  <option
                    key={a.asset_id}
                    value={a.asset_id}
                    style={dim ? { color: '#94a3b8' } : undefined}
                  >
                    {pickerLabel(a, tier)}
                  </option>
                );
              })}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
            </div>
          </div>
        </div>

        {/* THIS NODE is now a CLAIM THAT MUST BE TRUE, not decoration.
            The reasoning this comment used to carry -- "Maintainer view IS
            the tactical-edge tab" -- was sound while a tab and a node were
            the same thing, and became false the moment tiers got their own
            endpoints. It left `TACTICAL EDGE [THIS NODE]` rendering on the
            HQ host inside the demo shell: a composed edge view asserting it
            was the node you had connected to.
            The badge now renders only when the tier being shown is the tier
            this deployment serves, and renders NOTHING otherwise. In the
            shell that is always nothing, because a shell is a viewer and
            not a node. See lib/thisNode. */}
        <div className="flex flex-col items-center text-emerald-400">
          <Laptop className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">TACTICAL EDGE <ThisNodeBadge /></span>
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
