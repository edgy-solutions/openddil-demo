// =============================================================================
// RegionalHeader — regional-view toolbar
// =============================================================================
// Phase 4c.5: the regional buffer and link status are now REAL — read
// from useEdgeBuffer() (the edge_buffer_status shape). The left segment
// lists each child edge's own link (a toggle plus observed reachability from
// link_status); the right segment is this hub's own uplink to its parent. One
// proxy per link: cutting one never touches the other. The vestigial second
// link toggle (link2) was removed.
import { useEffect, useState } from 'react';
import { Laptop, Server, Building2, Settings } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { useEdgeBuffer } from '../../hooks';
import { useLinkIndicator } from '../../hooks/useLinkIndicator';
import { useLinkStatus } from '../../hooks/useLinkStatus';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';
import { classifyLink } from '../../lib/linkStatus';
import { LinkControlCaption } from '../LinkToggle';
import { deployment, isRootTier, parentDisplay, parentTierName } from '../../deployment';
import NetworkPopover from '../network/NetworkPopover';
import { BufferBlock, PathNode, PathRow, Section, StatusStrip, Wire } from '../network/PathDiagram';
import { LinkRow, type LinkObserved } from '../network/LinkRow';
import { formatLag } from '../network/linkShaping';
import { toneFromIndicator, toneFromReadings, worstTone } from '../network/tone';

// Same tones as Header.tsx -- see lib/linkIndicator.ts for why
// UNKNOWN/STALE are neutral rather than borrowing the up/severed palette.
const REGIONAL_HQ_INDICATOR_LABEL: Record<string, string> = {
  unknown: 'REGIONAL↔HQ: UNKNOWN',
  stale: 'REGIONAL↔HQ: STALE',
  probe_down: 'REGIONAL↔HQ: PROBE DOWN',
  severed: 'REGIONAL↔HQ: SEVERED',
  up: 'REGIONAL↔HQ: LINK UP',
};
// The uplink row's own observed word: the same indicator, in one word.
const UPLINK_WORD: Record<string, string> = {
  unknown: 'UNKNOWN',
  stale: 'STALE',
  probe_down: 'PROBE DOWN',
  severed: 'SEVERED',
  up: 'UP',
};
const LINK_INDICATOR_CLASS: Record<string, string> = {
  unknown: 'text-slate-400',
  stale: 'text-slate-400',
  probe_down: 'text-amber-400',
  severed: 'text-rose-500 glow-rose',
  up: 'text-emerald-400',
};

interface RegionalHeaderProps {
  /** Link control for this hub: its own uplink and its direct children's. */
  linkControl: UseLinkControlResult;
  setIsRuleEditorOpen: (v: boolean) => void;
}

export default function RegionalHeader({ linkControl, setIsRuleEditorOpen }: RegionalHeaderProps) {
  const { status, isError } = useEdgeBuffer();
  // Observed-only: the label never reads the commanded toggle state -- see
  // lib/linkIndicator.ts.
  const linkIndicator = useLinkIndicator(status, isError);
  const linkRows = useLinkStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const lag = status?.bridge_group_lag ?? 0;
  // Unrelated to the link label: still backs the MSGS-row dash display.
  const probeDown = status != null && !status.probe_healthy;
  // The right segment (hub -> parent) follows the observed indicator of this
  // hub's own uplink; the left segment follows its children's link rows.
  const severed = linkIndicator === 'severed';
  // Child ids: the control listing when it is available, else whatever
  // link_status rows this store holds (reachability stays visible when
  // link control is off).
  const childIds = linkControl.status === 'off'
    ? Array.from(linkRows.links.keys()).sort()
    : linkControl.children.map((c) => c.id);
  const readings = childIds.map((id) => classifyLink(linkRows.links.get(id), nowMs));
  // null with no children: they contribute nothing rather than a false "ok".
  const childrenTone = toneFromReadings(readings);
  // The parent comes from this tier's configuration, so it is named with
  // control off too; the listing is only a fallback.
  const configParent = parentTierName();
  const parentName = configParent ? parentDisplay(configParent) : (linkControl.uplink?.parent ?? null);
  const tierId = deployment().tier?.id;
  const ownName = tierId && !isRootTier(tierId) ? tierId : 'this hub';
  const uplinkTone = toneFromIndicator(linkIndicator);
  const uplinkObserved: LinkObserved = {
    word: UPLINK_WORD[linkIndicator],
    className: LINK_INDICATOR_CLASS[linkIndicator],
    tone: uplinkTone,
  };

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-40 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        <div className="flex flex-col items-center justify-center mr-4">
          <button
            onClick={() => setIsRuleEditorOpen(true)}
            className="flex items-center gap-2 bg-cyan-900/40 hover:bg-cyan-800/60 border border-cyan-700/50 text-cyan-400 px-3 py-2 rounded-sm transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="text-[10px] font-bold tracking-widest">CONFIGURE HEURISTICS</span>
          </button>
        </div>

        {/* Real edge-buffer depth: bridge-group consumer lag on redpanda-edge */}
        <NetworkPopover
          tone={worstTone(uplinkTone, childrenTone)}
          count={formatLag(probeDown, lag)}
          unit={parentName ? `MSGS → ${parentName.toUpperCase()}` : 'MSGS'}
        >
          <PathRow>
            <PathNode icon={Laptop} label="TACTICAL EDGE" />
            {/* TACTICAL EDGE <-> REGIONAL HUB: follows the children's
                link_status rows. */}
            <Wire tone={childrenTone ?? 'neutral'} />
            <PathNode icon={Server} me label="REGIONAL HUB" badge={<ThisNodeBadge />} />
            {/* REGIONAL HUB <-> CENTRAL HQ: this hub's own uplink. Its toggle
                cuts only this hop; the edge links are separate proxies. The
                wire follows the observed indicator. */}
            <Wire
              tone={uplinkTone}
              label={parentName ? `UPLINK TO ${parentName.toUpperCase()}` : 'UPLINK'}
            />
            <PathNode icon={Building2} label="CENTRAL HQ" />
          </PathRow>
          <StatusStrip>
            <span className={`text-[10px] font-bold tracking-widest ${LINK_INDICATOR_CLASS[linkIndicator]}`}>
              {REGIONAL_HQ_INDICATOR_LABEL[linkIndicator]}
            </span>
            <LinkControlCaption status={linkControl.status} />
          </StatusStrip>
          <BufferBlock
            label={parentName ? `UPLINK BUFFER → ${parentName}` : 'UPLINK BUFFER'}
            value={formatLag(probeDown, lag)}
            lag={lag}
            severed={severed}
          />
          {/* One row per child edge's own link (toggle = commanded, word =
              observed link_status). */}
          {childIds.length > 0 && (
            <Section title="DOWNLINKS">
              {childIds.map((id) => {
                const child = linkControl.children.find((c) => c.id === id);
                return (
                  <LinkRow
                    key={id}
                    linkKey={id}
                    toxicsId={`link-toxics-${id}`}
                    toggleId={`link-toggle-${id}`}
                    from={id}
                    to={ownName}
                    status={linkControl.status}
                    enabled={child?.enabled ?? null}
                    toggleFrom={id}
                    toggleTo="this hub"
                    onToggle={(v) => linkControl.set(id, v)}
                    toxics={child?.toxics ?? null}
                    onToxics={(t) => linkControl.setToxics(id, t)}
                    row={linkRows.links.get(id)}
                  />
                );
              })}
            </Section>
          )}
          <Section title="UPLINK">
            <LinkRow
              linkKey="uplink"
              toxicsId="uplink-toxics"
              toggleId="rtoggle1"
              from={ownName}
              to={parentName ?? 'parent'}
              status={linkControl.status}
              enabled={linkControl.uplink?.enabled ?? null}
              toggleFrom="this hub"
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
