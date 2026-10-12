// =============================================================================
// Header — maintainer-view toolbar
// =============================================================================
// Phase 4c.5: the buffer counter and link status are now REAL — read from
// useEdgeBuffer() (the edge_buffer_status shape the projector's monitor
// writes), not a client-side simulation. The link toggle cuts/restores this
// tier's own uplink to its parent (one proxy per link); the label beside it
// is the observed reachability, never the commanded state. The vestigial
// second link toggle (link2 — never backed by anything) was removed.
//
// The network itself (path diagram, observed link label, buffer, the uplink
// row with its toggle and shaping) lives in a popover opened from a pill in
// this bar; the bar keeps only the scope chrome. The pill's dot is the
// OBSERVED link indicator, never the commanded toggle.
import { Laptop, Building2, Server } from 'lucide-react';
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
import NationLegend from './releasability/NationLegend';
import { useSession } from '../hooks/useSession';
import { useLinkIndicator } from '../hooks/useLinkIndicator';
import type { UseLinkControlResult } from '../hooks/useLinkControl';
import { LinkControlCaption } from './LinkToggle';
import { deployment, isRootTier, parentDisplay, parentTierName } from '../deployment';
import NetworkPopover from './network/NetworkPopover';
import { BufferBlock, PathNode, PathRow, Section, StatusStrip, Wire } from './network/PathDiagram';
import { LinkRow, type LinkObserved } from './network/LinkRow';
import { formatLag } from './network/linkShaping';
import { toneFromIndicator } from './network/tone';

// Label text/tone per observed LinkIndicatorKind. UNKNOWN/STALE are
// deliberately neutral (grey) -- they are "no confirmed answer", not good
// or bad news, so they must not borrow the emerald/rose vocabulary used
// for a confirmed up/severed link.
const LINK_INDICATOR_LABEL: Record<string, string> = {
  unknown: 'LINK: UNKNOWN',
  stale: 'LINK: STALE',
  probe_down: 'LINK: PROBE DOWN',
  severed: 'DDIL: LINK SEVERED',
  // The row measures this tier's own uplink to its parent -- for an edge
  // that parent is its region, not HQ -- so "UPLINK" rather than naming HQ.
  up: 'UPLINK: LINK UP',
};
const LINK_INDICATOR_CLASS: Record<string, string> = {
  unknown: 'text-slate-400',
  stale: 'text-slate-400',
  probe_down: 'text-amber-400',
  severed: 'text-rose-500 glow-rose',
  up: 'text-emerald-400',
};

// The uplink row's own observed word: the same indicator, in one word.
const UPLINK_WORD: Record<string, string> = {
  unknown: 'UNKNOWN',
  stale: 'STALE',
  probe_down: 'PROBE DOWN',
  severed: 'SEVERED',
  up: 'UP',
};

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
  /** This tier's own uplink control (lib/linkControl). The toggle renders
   *  only when control is available; unknown or refused states render it
   *  disabled and explained, never as a guessed commanded state. */
  linkControl: Pick<UseLinkControlResult, 'status' | 'uplink' | 'set' | 'setToxics'>;
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
  linkControl,
  fleet, fleetTiers, selectedAsset, setSelectedAsset,
  availableEdges, selectedEdge, onSelectEdge,
}: HeaderProps) {
  const { status, isError } = useEdgeBuffer();
  // PRESENTATION ONLY. `session.nations` decides which legend keys are worth
  // showing and whether an asset is marked "released to you"; it filters
  // nothing. The rows below have already been filtered by the gateway
  // (ADR-0029 §1), and a second filter here would be a second authorization
  // decision that nobody reviewed.
  const session = useSession();
  // The label is a pure function of the OBSERVED edge_buffer_status row
  // (+ isError + wall clock) -- it never reads the commanded
  // toggle state and never falls back to it. See lib/linkIndicator.ts.
  const linkIndicator = useLinkIndicator(status, isError);
  const lag = status?.bridge_group_lag ?? 0;
  // Unrelated to the link label above: this still backs the separate
  // "UPLINK BUFFER" MSGS-count row's dash-vs-number display.
  const probeDown = status != null && !status.probe_healthy;
  // `severed` still drives the buffer trend arrow's colour; kept as an
  // observed-only derivation so it stays consistent with the indicator.
  const severed = linkIndicator === 'severed';
  // The parent comes from this tier's configuration, so it is named whether
  // or not link control is on; the listing is only a fallback.
  const configParent = parentTierName();
  const parentName = configParent ? parentDisplay(configParent) : (linkControl.uplink?.parent ?? null);
  const parentIsRoot = configParent == null || isRootTier(configParent);
  // Named by its own id when it has one, else generically.
  const tierId = deployment().tier?.id;
  const ownName = tierId && !isRootTier(tierId) ? tierId : 'this tier';
  // The uplink row's word is the observed indicator in one word, never the
  // commanded toggle.
  const uplinkObserved: LinkObserved = {
    word: UPLINK_WORD[linkIndicator],
    className: LINK_INDICATOR_CLASS[linkIndicator],
    tone: toneFromIndicator(linkIndicator),
  };

  return (
    <header className="panel flex flex-col p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      {/* WHOSE SCREEN IS THIS. Placed above everything else, because the
          answer changes what every number below it means — and in a
          side-by-side demo it is the only thing distinguishing two windows
          that are otherwise identical. */}
      <div className="mb-2 flex w-full max-w-6xl mx-auto items-center justify-between gap-4">
        <NationLegend assets={fleet} viewerNations={session.nations} />
        {/* MOVED TO THE SHARED SHELL CHROME (Root.tsx).
            It lived here, in the edge-shaped header only, so the HQ and
            REGIONAL shapes rendered a subject-scoped partition while
            naming no subject — ADR-0035 class 5, and the first concrete
            instance of the "three components are still three components"
            debt: a feature landed in one sibling and never reached the
            others. Chrome that must appear for EVERY shape belongs above
            the shape selection, not inside one of its branches. */}
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
        <div className="flex flex-col">
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

        {/* The network lives behind this pill. The dot is the OBSERVED link
            indicator (never the commanded toggle); the count is the uplink
            buffer. Real edge-buffer depth: bridge-group consumer lag on
            redpanda-edge. */}
        <NetworkPopover
          tone={toneFromIndicator(linkIndicator)}
          count={formatLag(probeDown, lag)}
          unit={parentName ? `MSGS → ${parentName.toUpperCase()}` : 'MSGS'}
        >
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
              not a node. See lib/thisNode.
              The path is THIS NODE and its PARENT only. An edge has no
              business showing what lies beyond its parent (a region may sit
              between it and HQ), and it lists no upstream link: it neither
              owns nor controls one. */}
          <PathRow>
            <PathNode icon={Laptop} me label="TACTICAL EDGE" badge={<ThisNodeBadge />} />
            {/* DDIL link -- the wire follows the observed indicator. */}
            <Wire
              tone={toneFromIndicator(linkIndicator)}
              label={parentName ? `UPLINK TO ${parentName.toUpperCase()}` : 'UPLINK'}
            />
            {/* The parent is NOT this node on the Maintainer tab -- dim it
                so the THIS-NODE highlight on TACTICAL EDGE reads clearly.
                Same dim-state styling HqHeader uses for TACTICAL EDGE. */}
            <PathNode
              icon={parentIsRoot ? Building2 : Server}
              label={parentIsRoot ? 'CENTRAL HQ' : parentName!.toUpperCase()}
            />
          </PathRow>
          <StatusStrip>
            <span className={`text-[10px] font-bold tracking-widest ${LINK_INDICATOR_CLASS[linkIndicator]}`}>
              {LINK_INDICATOR_LABEL[linkIndicator]}
            </span>
            <LinkControlCaption status={linkControl.status} />
          </StatusStrip>
          <BufferBlock
            label={parentName ? `UPLINK BUFFER → ${parentName}` : 'UPLINK BUFFER'}
            value={formatLag(probeDown, lag)}
            lag={lag}
            severed={severed}
          />
          <Section title="UPLINK">
            <LinkRow
              linkKey="uplink"
              toxicsId="uplink-toxics"
              toggleId="toggle1"
              from={ownName}
              to={parentName ?? 'parent'}
              status={linkControl.status}
              enabled={linkControl.uplink?.enabled ?? null}
              toggleFrom="this tier"
              toggleTo={parentName}
              onToggle={(v) => linkControl.set('uplink', v)}
              toxics={linkControl.uplink?.toxics ?? null}
              onToxics={(t) => linkControl.setToxics('uplink', t)}
              observed={uplinkObserved}
            />
          </Section>
        </NetworkPopover>
      </div>
    </header>
  );
}
