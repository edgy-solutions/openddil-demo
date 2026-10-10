// LinkToggle — the cut/restore switch for one link, plus the child-link row
// that pairs a switch with the link's observed reachability.
//
// The switch shows the COMMANDED state (what the proxy is set to); the
// reachability word beside it is OBSERVED (a link_status row, or the edge
// buffer for this tier's own uplink). They are deliberately separate: a
// restored link reads DOWN until heartbeats actually cross it again.
import { useEffect, useState } from 'react';
import type { LinkControlStatus, LinkToxics } from '../lib/linkControl';
import { linkToggleAvailability } from '../lib/linkControl';
import { LinkToxicsControl } from './LinkToxics';
import {
  classifyLink,
  formatDataAge,
  linkDataAgeS,
  linkStateWord,
  type LinkState,
  type LinkStatusRow,
} from '../lib/linkStatus';

const FORBIDDEN_TEXT = 'Link control: not authorised';

export interface LinkToggleProps {
  /** Unique DOM id (label wiring). */
  id: string;
  /** null = unknown; rendered grey and never guessed. */
  enabled: boolean | null;
  disabled: boolean;
  title: string;
  onChange: (v: boolean) => void;
}

export function LinkToggle({ id, enabled, disabled, title, onChange }: LinkToggleProps) {
  return (
    <div className="relative inline-block w-12 align-middle select-none transition duration-200 ease-in">
      <input
        type="checkbox"
        id={id}
        className="toggle-checkbox absolute block w-6 h-6 rounded-none bg-white border-4 appearance-none cursor-pointer z-10 opacity-0 disabled:cursor-not-allowed"
        checked={enabled ?? false}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} title={title} className={`toggle-label block overflow-hidden h-6 rounded-none cursor-pointer transition-colors duration-200 ease-in-out ${enabled === null ? 'bg-slate-600' : enabled ? 'bg-emerald-500' : 'bg-rose-500'}`}>
        <span className={`toggle-dot absolute left-0 block w-6 h-6 bg-white border-2 border-slate-900 transition-transform duration-200 ease-in-out ${enabled ? 'translate-x-full' : ''}`}></span>
      </label>
    </div>
  );
}

/** Caption shown under a control whose subject may not use it. */
export function LinkControlCaption({ status }: { status: LinkControlStatus }) {
  if (status !== 'forbidden') return null;
  return <span className="text-[9px] mt-0.5 text-slate-500 tracking-widest">{FORBIDDEN_TEXT}</span>;
}

const STATE_CLASS: Record<LinkState, string> = {
  up: 'text-emerald-400',
  idle: 'text-amber-400',
  down: 'text-rose-400',
  unknown: 'text-slate-400',
};

export interface ChildLinkRowProps {
  /** The child tier's id (edge-01, region-east, ...). */
  id: string;
  /** This tier's link_status row for the child, if any. */
  row: LinkStatusRow | undefined;
  status: LinkControlStatus;
  /** The child's commanded state from the listing; null when not listed. */
  enabled: boolean | null;
  /** This tier's own id/name for the toggle title (the parent end). */
  parent: string;
  onChange: (v: boolean) => void;
  /** The child link's applied latency/jitter/bandwidth; null when not listed. */
  toxics: LinkToxics | null;
  onToxics: (t: LinkToxics) => void;
}

export function ChildLinkRow({ id, row, status, enabled, parent, onChange, toxics, onToxics }: ChildLinkRowProps) {
  // Re-classify on a timer so a row that stops refreshing ages to UNKNOWN
  // without a new row arriving.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const reading = classifyLink(row, nowMs);
  const avail = linkToggleAvailability(status, enabled, id, parent);
  return (
    <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest">
      <span className="text-slate-300 min-w-[64px] text-left">{id}</span>
      {avail.show && (
        <LinkToggle
          id={`link-toggle-${id}`}
          enabled={enabled}
          disabled={avail.disabled}
          title={avail.title}
          onChange={onChange}
        />
      )}
      <LinkToxicsControl id={`link-toxics-${id}`} toxics={toxics} status={status} onApply={onToxics} />
      <span className={STATE_CLASS[reading.state]}>{linkStateWord(reading)}</span>
      <span className="text-slate-400" title="Age of the freshest heartbeat">
        {formatDataAge(linkDataAgeS(row))}
      </span>
    </div>
  );
}
