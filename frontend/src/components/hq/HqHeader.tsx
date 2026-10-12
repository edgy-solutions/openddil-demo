// =============================================================================
// HqHeader — HQ-view toolbar
// =============================================================================
// Phase 4c.5: the global buffer backlog is REAL — read from useEdgeBuffer()
// (the edge_buffer_status shape). HQ is the root of the tree and has no
// uplink, so there is no uplink toggle. HQ's direct-link rows (one per direct
// child: toggle, toxics, observed reachability) sit ON THE LINK THEY CONTROL:
//   - a child that rolls up its own subtree (a hub) controls the hub -> HQ
//     link, so its row sits on the REGIONAL HUBS -> CENTRAL HQ segment;
//   - a leaf child attached directly to HQ controls a link that goes AROUND
//     the hub, so its row sits on a second line that leaves the TACTICAL EDGE
//     column, runs under the hub and rises into CENTRAL HQ;
//   - a child whose shape is not declared sits on the edge -> hub segment,
//     titled as such: a visible exception, never a silent placement.
// Placement reads `childLinkShape(id)` (declared in deployment.json) and
// nothing else -- SHAPE, never the id's spelling (see lib/tierShape.ts). The
// aggregate count stays in TheaterReadinessPosture (GLOBAL LINK STATUS).
//
// The network (path diagram, observed link caption, backlog, the placed link
// rows with their toggles and shaping) lives in a popover opened from a pill
// in this bar; the bar keeps the exercise control. The pill's dot is OBSERVED
// state only (the children's link_status readings), never a commanded toggle.
// Row placement is unchanged: rollup rows on hub -> HQ, leaf rows on the
// direct line, undeclared rows on edge -> hub with the title on each row.
import { useEffect, useState } from 'react';
import { Laptop, Server, Building2 } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { childLinkShape } from '../../deployment';
import { useEdgeBuffer, useLinkStatus } from '../../hooks';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';
import { classifyLink } from '../../lib/linkStatus';
import { LinkControlCaption } from '../LinkToggle';
import NetworkPopover from '../network/NetworkPopover';
import {
  BufferBlock, DirectArc, PathNode, PathRow, Section, StatusStrip, Wire,
} from '../network/PathDiagram';
import { LinkRow } from '../network/LinkRow';
import { formatLag } from '../network/linkShaping';
import { toneFromReadings } from '../network/tone';
import ExercisePopup from './ExercisePopup';

interface HqHeaderProps {
  /** Link control for HQ's direct children (one hook instance per page). */
  linkControl: UseLinkControlResult;
}

const UNDECLARED_TITLE = 'link shape not declared in deployment.json';

export default function HqHeader({ linkControl }: HqHeaderProps) {
  const { status } = useEdgeBuffer();
  const linkRows = useLinkStatus();
  // Re-classify on a timer so a row that stops refreshing ages to UNKNOWN.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  // Control listing when available, else whatever link_status rows this store
  // holds, so reachability stays visible with control off.
  const childIds = linkControl.status === 'off'
    ? Array.from(linkRows.links.keys()).sort()
    : linkControl.children.map((c) => c.id);
  const lag = status?.bridge_group_lag ?? 0;
  const probeDown = status != null && !status.probe_healthy;

  const rollupIds = childIds.filter((id) => childLinkShape(id) === 'rollup');
  const leafIds = childIds.filter((id) => childLinkShape(id) === 'leaf');
  const undeclaredIds = childIds.filter((id) => childLinkShape(id) === undefined);

  const tone = (ids: string[]) =>
    toneFromReadings(ids.map((id) => classifyLink(linkRows.links.get(id), nowMs)));

  const row = (id: string, title?: string) => {
    const child = linkControl.children.find((c) => c.id === id);
    return (
      <div key={id} title={title}>
        <LinkRow
          linkKey={id}
          toxicsId={`link-toxics-${id}`}
          toggleId={`link-toggle-${id}`}
          from={id}
          to="HQ"
          status={linkControl.status}
          enabled={child?.enabled ?? null}
          toggleFrom={id}
          toggleTo="HQ"
          onToggle={(v) => linkControl.set(id, v)}
          toxics={child?.toxics ?? null}
          onToxics={(t) => linkControl.setToxics(id, t)}
          row={linkRows.links.get(id)}
        />
      </div>
    );
  };

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700 transition-colors duration-500">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        {/* Exercise control -- a separate capability from link control
            (controls the DIS simulator/adapter via its own service, never a
            link). Self-contained: polls its own status, so it takes no props
            from this header. */}
        <ExercisePopup />

        {/* Real edge-buffer backlog: bridge-group consumer lag on redpanda-edge */}
        <NetworkPopover
          tone={tone(childIds) ?? 'neutral'}
          count={formatLag(probeDown, lag)}
          unit="MSGS BACKLOG"
        >
          <PathRow>
            <PathNode icon={Laptop} label="TACTICAL EDGE" />
            <Wire tone={tone(undeclaredIds) ?? 'neutral'} testId="wire-edge-hub" />
            <PathNode icon={Server} label="REGIONAL HUBS" />
            <Wire tone={tone(rollupIds) ?? 'neutral'} testId="wire-hub-hq" />
            <PathNode icon={Building2} me label="CENTRAL HQ" badge={<> <ThisNodeBadge /></>} />
          </PathRow>
          {/* The link that goes AROUND the hub; only drawn when a leaf child
              exists. */}
          {leafIds.length > 0 && <DirectArc tone={tone(leafIds) ?? 'neutral'} testId="wire-direct" />}
          <StatusStrip>
            <span />
            <LinkControlCaption status={linkControl.status} />
          </StatusStrip>
          <BufferBlock label="GLOBAL BUFFER BACKLOG" value={formatLag(probeDown, lag)} lag={lag} severed={false} />
          {undeclaredIds.length > 0 && (
            <Section title="EDGE → HUB · SHAPE NOT DECLARED" testId="link-seg-edge-hub">
              {undeclaredIds.map((id) => row(id, UNDECLARED_TITLE))}
            </Section>
          )}
          {rollupIds.length > 0 && (
            <Section title="REGIONAL HUBS → HQ" testId="link-seg-hub-hq">
              {rollupIds.map((id) => row(id))}
            </Section>
          )}
          {leafIds.length > 0 && (
            <Section title="DIRECT · EDGE → HQ" testId="link-direct-edge-hq">
              {leafIds.map((id) => row(id))}
            </Section>
          )}
        </NetworkPopover>
      </div>
    </header>
  );
}
