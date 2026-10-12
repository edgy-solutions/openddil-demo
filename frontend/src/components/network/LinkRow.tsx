// =============================================================================
// LinkRow — one link in the network popover
// =============================================================================
// `from → to`, small tags for the toxics that are set, the OBSERVED state word
// and data age, the commanded-state toggle, and a caret. Clicking the row
// (anywhere but the toggle) expands the LinkShapingPanel inline.
//
// The toggle shows the COMMANDED state (what the proxy is set to); the state
// word beside it is OBSERVED (a link_status row, or the edge buffer for this
// tier's own uplink). They are deliberately separate: a restored link reads
// DOWN until heartbeats actually cross it again. The tags are the APPLIED
// toxics and are a "this link is shaped" cue only -- they never feed the state
// word or any tone.
//
// A child link's word is classified here from its link_status row and
// re-classified on a timer, so a row that stops refreshing ages to UNKNOWN
// without a new row arriving. The uplink has no link_status row; its caller
// passes the word derived from the observed indicator instead.
import { useEffect, useState, type MouseEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { LinkToggle } from '../LinkToggle';
import { LinkShapingPanel } from './LinkShapingPanel';
import { useExpansion } from './expansion';
import { toxicTags } from './linkShaping';
import { STATE_CLASS, toneFromLinkState, type Tone } from './tone';
import {
  classifyLink, formatDataAge, linkDataAgeS, linkStateWord, type LinkStatusRow,
} from '../../lib/linkStatus';
import {
  linkToggleAvailability, linkToxicsAvailability,
  type LinkControlStatus, type LinkToxics,
} from '../../lib/linkControl';

export interface LinkObserved {
  word: string;
  /** Text colour class for the word. */
  className: string;
  tone: Tone;
  /** Data age text; omitted when the link has none (the uplink). */
  age?: string;
}

export interface LinkRowProps {
  /** Expansion key, unique within the popover. */
  linkKey: string;
  /** DOM id prefix for the shaping sliders (`link-toxics-edge-01`). */
  toxicsId: string;
  /** DOM id of the toggle checkbox (`toggle1`, `link-toggle-edge-01`). */
  toggleId: string;
  from: string;
  to: string;
  status: LinkControlStatus;
  /** Commanded state; null when not listed. */
  enabled: boolean | null;
  /** Toggle title wording: "Cut or restore the uplink from X to Y". */
  toggleFrom: string;
  toggleTo: string | null;
  onToggle: (v: boolean) => void;
  /** Applied toxics; null when not listed. */
  toxics: LinkToxics | null;
  onToxics: (t: LinkToxics) => void;
  /** This tier's link_status row for a child link. Ignored with `observed`. */
  row?: LinkStatusRow;
  /** Pre-computed observed word (the uplink). */
  observed?: LinkObserved;
  /** Hover title for the whole row. */
  title?: string;
}

const TONE_MARK: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  neutral: 'bg-slate-600',
};

export function LinkRow(p: LinkRowProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const { open, toggle } = useExpansion(p.linkKey);

  let observed: LinkObserved;
  if (p.observed) {
    observed = p.observed;
  } else {
    const reading = classifyLink(p.row, nowMs);
    observed = {
      word: linkStateWord(reading),
      className: STATE_CLASS[reading.state],
      tone: toneFromLinkState(reading.state, reading.declaredIdle),
      age: formatDataAge(linkDataAgeS(p.row)),
    };
  }

  const toggleAvail = linkToggleAvailability(p.status, p.enabled, p.toggleFrom, p.toggleTo);
  const expandable = linkToxicsAvailability(p.status, p.toxics).show;
  const tags = toxicTags(p.toxics);

  function onRowClick(e: MouseEvent<HTMLDivElement>) {
    if (!expandable) return;
    // The toggle is its own control: operating it must not expand the row.
    if ((e.target as HTMLElement).closest('[data-no-expand]')) return;
    toggle();
  }

  const summary = (
    <>
      <span className="flex min-w-0 items-center gap-2 text-slate-200">
        <span className="truncate">{p.from}</span>
        <span aria-hidden="true" className={`h-[2px] w-[18px] flex-none ${TONE_MARK[observed.tone]}`} />
        <span aria-hidden="true" className="text-slate-500">→</span>
        <span className="truncate">{p.to}</span>
      </span>
      <span className="flex flex-wrap items-center justify-end gap-1">
        {tags.map((t) => (
          <span
            key={t}
            data-testid="toxic-tag"
            className="whitespace-nowrap rounded-sm border border-amber-500/30 bg-amber-500/10 px-[5px] py-[2px] text-[9px] text-amber-300"
          >
            {t}
          </span>
        ))}
        <span className={`whitespace-nowrap text-[10px] font-bold tracking-widest ${observed.className}`}>{observed.word}</span>
        {observed.age !== undefined && (
          <span className="whitespace-nowrap text-[10px] font-bold tracking-widest text-slate-400" title="Age of the freshest heartbeat">
            {observed.age}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div
      title={p.title}
      className={`rounded-sm border transition-colors ${open ? 'border-cyan-400/35 bg-cyan-950/20' : 'border-transparent'}`}
    >
      <div
        onClick={onRowClick}
        className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-sm p-2 text-[11px] ${expandable ? 'cursor-pointer hover:bg-cyan-400/5' : ''}`}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${p.from} to ${p.to}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 text-left"
          >
            {summary}
          </button>
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5">{summary}</div>
        )}
        <span data-no-expand className="flex items-center">
          {toggleAvail.show && (
            <LinkToggle
              id={p.toggleId}
              enabled={p.enabled}
              disabled={toggleAvail.disabled}
              title={toggleAvail.title}
              onChange={p.onToggle}
            />
          )}
        </span>
        <span aria-hidden="true" className={`grid w-3 transition-transform ${expandable ? '' : 'invisible'} ${open ? 'rotate-90 text-cyan-400' : 'text-slate-500'}`}>
          <ChevronRight className="h-3 w-3" />
        </span>
      </div>
      {open && expandable && (
        <LinkShapingPanel
          id={p.toxicsId}
          toxics={p.toxics}
          enabled={p.enabled}
          status={p.status}
          onApply={p.onToxics}
          onSetEnabled={p.onToggle}
        />
      )}
    </div>
  );
}
