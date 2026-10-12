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
import { useEdgeBuffer } from '../hooks';
import { useLinkIndicator } from '../hooks/useLinkIndicator';
import type { UseLinkControlResult } from '../hooks/useLinkControl';
import { LinkControlCaption } from './LinkToggle';
import { deployment, isRootTier, parentDisplay, parentTierName } from '../deployment';
import NetworkPopover from './network/NetworkPopover';
import { LinkSummary, PathNode, PathRow, Section, StatusStrip, Wire } from './network/PathDiagram';
import { TopBarPortal } from './TopBarSlot';
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

interface HeaderProps {
  /** This tier's own uplink control (lib/linkControl). The toggle renders
   *  only when control is available; unknown or refused states render it
   *  disabled and explained, never as a guessed commanded state. */
  linkControl: Pick<UseLinkControlResult, 'status' | 'uplink' | 'set' | 'setToxics'>;
}

export default function Header({ linkControl }: HeaderProps) {
  const { status, isError } = useEdgeBuffer();
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
    <TopBarPortal>
        {/* The network lives behind this pill. The dot is the OBSERVED link
            indicator (never the commanded toggle); the count is the uplink
            buffer. Real edge-buffer depth: bridge-group consumer lag on
            redpanda-edge. */}
        <NetworkPopover
          tone={toneFromIndicator(linkIndicator)}
          summary={
            <LinkSummary
              word={LINK_INDICATOR_LABEL[linkIndicator]}
              wordClass={LINK_INDICATOR_CLASS[linkIndicator]}
              value={formatLag(probeDown, lag)}
              lag={lag}
              severed={severed}
              bufferLabel={parentName ? `UPLINK BUFFER → ${parentName}` : 'UPLINK BUFFER'}
            />
          }
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
            <LinkControlCaption status={linkControl.status} />
          </StatusStrip>
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
    </TopBarPortal>
  );
}
