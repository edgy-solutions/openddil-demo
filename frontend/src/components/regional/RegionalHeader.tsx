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
import { Laptop, Server, Building2, TrendingUp, Settings } from 'lucide-react';
import { ThisNodeBadge } from '../../lib/thisNode';
import { useEdgeBuffer } from '../../hooks';
import { useLinkIndicator } from '../../hooks/useLinkIndicator';
import { useLinkStatus } from '../../hooks/useLinkStatus';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';
import { allLinksDown, classifyLink } from '../../lib/linkStatus';
import {
  ChildLinkRow,
  LinkControlCaption,
  LinkToggle,
} from '../LinkToggle';
import { LinkToxicsControl } from '../LinkToxics';
import { linkToggleAvailability } from '../../lib/linkControl';

// Same tones as Header.tsx -- see lib/linkIndicator.ts for why
// UNKNOWN/STALE are neutral rather than borrowing the up/severed palette.
const REGIONAL_HQ_INDICATOR_LABEL: Record<string, string> = {
  unknown: 'REGIONAL↔HQ: UNKNOWN',
  stale: 'REGIONAL↔HQ: STALE',
  probe_down: 'REGIONAL↔HQ: PROBE DOWN',
  severed: 'REGIONAL↔HQ: SEVERED',
  up: 'REGIONAL↔HQ: LINK UP',
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
  const childrenDown = allLinksDown(childIds.map((id) => classifyLink(linkRows.links.get(id), nowMs)));
  const uplinkToggle = linkToggleAvailability(
    linkControl.status,
    linkControl.uplink?.enabled ?? null,
    'this hub',
    linkControl.uplink?.parent ?? null,
  );
  // Named only from the listing; with control off the parent is not known here.
  const parentName = linkControl.uplink?.parent ?? null;

  return (
    <header className="panel flex items-center justify-between p-3 m-2 shrink-0 z-10 border-b-2 border-b-slate-700">
      <div className="flex items-center space-x-6 w-full max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-slate-400">
          <Laptop className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">TACTICAL EDGE</span>
        </div>

        {/* TACTICAL EDGE <-> REGIONAL HUB: one row per child edge's own link */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${childrenDown ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <div className="flex flex-col gap-1 mt-1">
            {childIds.map((id) => (
              <ChildLinkRow
                key={id}
                id={id}
                row={linkRows.links.get(id)}
                status={linkControl.status}
                enabled={linkControl.children.find((c) => c.id === id)?.enabled ?? null}
                parent="this hub"
                onChange={(v) => linkControl.set(id, v)}
                toxics={linkControl.children.find((c) => c.id === id)?.toxics ?? null}
                onToxics={(t) => linkControl.setToxics(id, t)}
              />
            ))}
          </div>
          <LinkControlCaption status={linkControl.status} />
        </div>

        <div className="flex flex-col items-center text-emerald-400">
          <Server className="w-6 h-6 mb-1 glow-emerald" />
          <span className="text-xs font-bold tracking-wider text-emerald-300">REGIONAL HUB <ThisNodeBadge /></span>
        </div>

        {/* REGIONAL HUB <-> CENTRAL HQ: this hub's own uplink. Its toggle
            cuts only this hop; the edge links on the left are separate
            proxies. The bar and dot follow the observed indicator. */}
        <div className="flex-1 flex flex-col items-center relative">
          <div className={`absolute w-full h-[2px] top-3 -z-10 ${severed ? 'bg-rose-900' : 'bg-slate-700'}`}></div>
          <span className="text-[9px] tracking-widest text-slate-500">
            {parentName ? `UPLINK TO ${parentName.toUpperCase()}` : 'UPLINK'}
          </span>
          {uplinkToggle.show ? (
            <div className="mt-1 mr-2 flex items-center gap-2">
              <LinkToggle
                id="rtoggle1"
                enabled={linkControl.uplink?.enabled ?? null}
                disabled={uplinkToggle.disabled}
                title={uplinkToggle.title}
                onChange={(v) => linkControl.set('uplink', v)}
              />
              <LinkToxicsControl
                id="uplink-toxics"
                toxics={linkControl.uplink?.toxics ?? null}
                status={linkControl.status}
                onApply={(t) => linkControl.setToxics('uplink', t)}
              />
            </div>
          ) : (
            <div className={`w-3 h-3 rounded-full mt-1.5 ${severed ? 'bg-rose-500' : 'bg-emerald-500 shadow-[0_0_10px_#10b981]'}`}></div>
          )}
          <span className={`text-[10px] mt-2 font-bold tracking-widest ${LINK_INDICATOR_CLASS[linkIndicator]}`}>
            {REGIONAL_HQ_INDICATOR_LABEL[linkIndicator]}
          </span>
        </div>

        <div className="flex flex-col items-center text-slate-400 mr-8">
          <Building2 className="w-6 h-6 mb-1 text-slate-200" />
          <span className="text-xs font-bold tracking-wider">CENTRAL HQ</span>
        </div>

        <div className="flex flex-col items-center justify-center mr-4">
          <button
            onClick={() => setIsRuleEditorOpen(true)}
            className="flex items-center gap-2 bg-cyan-900/40 hover:bg-cyan-800/60 border border-cyan-700/50 text-cyan-400 px-3 py-2 rounded transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="text-[10px] font-bold tracking-widest">CONFIGURE HEURISTICS</span>
          </button>
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
