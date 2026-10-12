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
import { Laptop, Server, Building2, TrendingUp } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { childLinkShape } from '../../deployment';
import { useEdgeBuffer, useLinkStatus } from '../../hooks';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';
import { ChildLinkRow, LinkControlCaption } from '../LinkToggle';
import ExercisePopup from './ExercisePopup';

interface HqHeaderProps {
  /** Link control for HQ's direct children (one hook instance per page). */
  linkControl: UseLinkControlResult;
}

const UNDECLARED_TITLE = 'link shape not declared in deployment.json';

export default function HqHeader({ linkControl }: HqHeaderProps) {
  const { status } = useEdgeBuffer();
  const linkRows = useLinkStatus();
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

  const row = (id: string, title?: string) => {
    const child = linkControl.children.find((c) => c.id === id);
    const el = (
      <ChildLinkRow
        id={id}
        row={linkRows.links.get(id)}
        status={linkControl.status}
        enabled={child?.enabled ?? null}
        parent="HQ"
        onChange={(v) => linkControl.set(id, v)}
        toxics={child?.toxics ?? null}
        onToxics={(t) => linkControl.setToxics(id, t)}
      />
    );
    return title
      ? <div key={id} title={title}>{el}</div>
      : <div key={id}>{el}</div>;
  };

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700 transition-colors duration-500">
      <div className="flex items-start space-x-6 w-full max-w-6xl mx-auto">
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Row 1: edge -> hub -> HQ. Icon columns share one width so the
              second line can be inset by half of it. */}
          <div className="grid grid-cols-[7rem_1fr_7rem_1fr_7rem] items-start">
            <div className="flex flex-col items-center text-slate-500">
              <Laptop className="w-6 h-6 mb-1 text-slate-600" />
              <span className="text-[10px] font-bold tracking-wider">TACTICAL EDGE</span>
            </div>
            <div data-testid="link-seg-edge-hub" className="flex flex-col items-center relative">
              <div className="absolute w-full h-[2px] bg-slate-700 top-3 -z-10"></div>
              <div className="flex flex-col gap-1 mt-1">
                {undeclaredIds.map((id) => row(id, UNDECLARED_TITLE))}
              </div>
            </div>
            <div className="flex flex-col items-center text-slate-400">
              <Server className="w-6 h-6 mb-1 text-slate-300" />
              <span className="text-[10px] font-bold tracking-wider">REGIONAL HUBS</span>
            </div>
            <div data-testid="link-seg-hub-hq" className="flex flex-col items-center relative">
              <div className="absolute w-full h-[2px] bg-slate-700 top-3 -z-10"></div>
              <div className="flex flex-col gap-1 mt-1">
                {rollupIds.map((id) => row(id))}
              </div>
            </div>
            <div className="flex flex-col items-center text-emerald-400">
              <Building2 className="w-6 h-6 mb-1 glow-emerald" />
              <span className="text-xs font-bold tracking-wider text-emerald-300">CENTRAL HQ <ThisNodeBadge /></span>
            </div>
            {/* Row 2: the link that goes AROUND the hub. The line spans the
                edge column's centre to the HQ column's centre; the rows sit
                under the hub because this block shares row 1's column
                tracks. The rows name both column lines: an absolutely
                positioned grid child with an auto end line spans to the
                container's edge, not one track. Only drawn when a leaf child
                exists. */}
            {leafIds.length > 0 && (
              <div
                data-testid="link-direct-edge-hq"
                className="col-span-5 grid grid-cols-subgrid relative h-6 mb-8"
              >
                <div className="absolute inset-y-0 left-[3.5rem] right-[3.5rem] border-l-2 border-r-2 border-b-2 border-slate-700 rounded-b" />
                <div className="col-start-3 col-end-4 row-start-1 absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 w-max flex flex-col gap-1">
                  {leafIds.map((id) => row(id))}
                </div>
              </div>
            )}
          </div>
          <LinkControlCaption status={linkControl.status} />
        </div>
        {/* Exercise control -- a separate capability from link control
            (controls the DIS simulator/adapter via its own service, never a
            link). Self-contained: polls its own status, so it takes no props
            from this header. */}
        <ExercisePopup />

        {/* Real edge-buffer backlog: bridge-group consumer lag on redpanda-edge */}
        <div className="pl-6 border-l border-slate-700 min-w-[160px]">
          <div className="text-[10px] text-slate-400 tracking-wider">GLOBAL BUFFER BACKLOG</div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-bold text-slate-100">
              {probeDown ? '—' : lag > 1000 ? (lag / 1000).toFixed(1) + 'K' : lag}
            </span>
            <span className="text-xs text-slate-500">MSGS</span>
            <TrendingUp className={`w-4 h-4 transition-all ${lag === 0 ? 'opacity-0' : 'opacity-100'} text-emerald-500 rotate-180`} />
          </div>
        </div>
      </div>
    </header>
  );
}
