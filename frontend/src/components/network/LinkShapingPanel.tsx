// =============================================================================
// LinkShapingPanel — profile tiles + latency / jitter / bandwidth for one link
// =============================================================================
// Replaces the inline LAT/JIT/BW number boxes of LinkToxicsControl with a
// DRAFT the user edits and then APPLIES. The semantics are the same ones
// LinkToxicsControl had:
//   - the draft mirrors the link's APPLIED (commanded) toxics until the user
//     edits something; `draft === null` means "show the applied state";
//   - APPLY sends the COMPLETE LinkToxics for the link (never a partial), and
//     is refused locally when a value is outside the PEP's bounds;
//   - CLEAR sends all zeros at once (today's CLR), it does not wait for APPLY;
//   - a slow link is still up: shaping never touches reachability, and nothing
//     here is read back as an observed state.
// The one addition is the SEVERED profile, which is the link TOGGLE off, not a
// toxic: choosing it and applying calls onSetEnabled(false) (and un-severing
// with any other profile calls onSetEnabled(true)). The toggle is still a
// separate, immediate control on the row; this panel only commits it together
// with the toxics when the user presses APPLY.
//
// Availability follows linkToxicsAvailability() exactly: hidden when link
// control is off; shown but disabled and explained when forbidden/unavailable.
//
// The sliders are native <input type=range> with ids derived from the link's
// id. They are mounted once per expansion and only their values change, so a
// drag keeps focus.
import { useState, type CSSProperties } from 'react';
import { Lock, Wifi, Activity, Zap } from 'lucide-react';
import { linkToxicsAvailability } from '../../lib/linkControl';
import type { LinkControlStatus, LinkToxics } from '../../lib/linkControl';
import {
  PRESETS, SEVERITY_COLOR, ZERO_TOXICS,
  bwToP, fbw, fjit, fms, msToP, pToBw, pToMs, presetOf, presetRows,
  sBw, sJit, sLat, toxicsToValues, valuesToToxics,
  type Severity,
} from './linkShaping';
import './network.css';

type SliderKey = 'lat' | 'jit' | 'bw';

// The draft. `up: null` follows the live toggle; `pos` remembers the slider
// position the user dragged to, so the thumb does not snap while a log-scaled
// value rounds (e.g. 1 ms and 2 ms share the first few positions).
interface Draft {
  up: boolean | null;
  lat: number;
  jit: number;
  bw: number;
  pos: Partial<Record<SliderKey, number>>;
}

export interface LinkShapingPanelProps {
  /** DOM id prefix; sliders are `${id}-latency`, `-jitter`, `-bandwidth`. */
  id: string;
  /** The applied state from the listing; null = unknown. */
  toxics: LinkToxics | null;
  /** The commanded link state (toggle); null = unknown. */
  enabled: boolean | null;
  status: LinkControlStatus;
  onApply: (t: LinkToxics) => void;
  onSetEnabled: (v: boolean) => void;
}

const BADGE: Record<Severity, string> = {
  ok: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/40',
  warn: 'text-amber-300 bg-amber-500/10 border-amber-500/40',
  bad: 'text-rose-300 bg-rose-500/10 border-rose-500/40',
};

function sliderStyle(position: number, sev: Severity): CSSProperties {
  return { '--p': `${position / 10}%`, '--fill': SEVERITY_COLOR[sev] } as CSSProperties;
}

function SignalBars({ lit, color }: { lit: number; color: string }) {
  const heights = [4, 6, 8, 11];
  return (
    <span aria-hidden="true" className="flex h-[11px] flex-none items-end gap-[2px]">
      {heights.map((h, i) => (
        <i
          key={h}
          className="block w-[3px] rounded-[1px] bg-slate-700"
          style={{ height: h, ...(i < lit ? { background: color, boxShadow: `0 0 6px ${color}` } : {}) }}
        />
      ))}
    </span>
  );
}

export function LinkShapingPanel({ id, toxics, enabled, status, onApply, onSetEnabled }: LinkShapingPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rejected, setRejected] = useState(false);
  // The live toggle moved: a pending explicit up/down choice is stale, follow
  // the toggle again. (Adjusting state while rendering, the documented
  // alternative to an effect for "reset when a prop changes".)
  const [seenEnabled, setSeenEnabled] = useState(enabled);
  if (seenEnabled !== enabled) {
    setSeenEnabled(enabled);
    if (draft && draft.up !== null) setDraft({ ...draft, up: null });
  }

  const avail = linkToxicsAvailability(status, toxics);
  if (!avail.show) return null;
  const locked = avail.disabled;

  const appliedUp = enabled ?? true;
  const base: Draft = draft ?? { ...toxicsToValues(toxics, appliedUp), up: null, pos: {} };
  const up = base.up ?? appliedUp;
  const values = { up, lat: base.lat, jit: base.jit, bw: base.bw };
  const applied = toxicsToValues(toxics, appliedUp);
  const dirty =
    draft !== null &&
    (values.lat !== applied.lat || values.jit !== applied.jit || values.bw !== applied.bw || up !== appliedUp);
  const cur = presetOf(values);
  const custom = cur < 0;
  const dimmed = !up;

  function edit(patch: Partial<Draft>) {
    setRejected(false);
    setDraft({ ...base, ...patch });
  }

  function choose(i: number) {
    const v = PRESETS[i].values;
    setRejected(false);
    // A non-severed profile also un-severs; SEVERED clears the shaping.
    setDraft({ up: v.up, lat: v.lat, jit: v.jit, bw: v.bw, pos: {} });
  }

  function slide(key: SliderKey, p: number) {
    const v = key === 'bw' ? pToBw(p) : pToMs(p);
    edit({ [key]: v, pos: { ...base.pos, [key]: p } });
  }

  function position(key: SliderKey): number {
    const remembered = base.pos[key];
    if (key === 'bw') {
      if (remembered !== undefined && pToBw(remembered) === base.bw) return remembered;
      return Math.min(1000, bwToP(base.bw));
    }
    if (remembered !== undefined && pToMs(remembered) === base[key]) return remembered;
    return Math.min(1000, msToP(base[key]));
  }

  function apply() {
    const out = valuesToToxics(values);
    if (out === null) {
      setRejected(true);
      return;
    }
    onApply(out);
    if (up !== appliedUp) onSetEnabled(up);
    setDraft(null);
    setRejected(false);
  }

  function clear() {
    onApply({ ...ZERO_TOXICS });
    setDraft(null);
    setRejected(false);
  }

  const sb = sBw(values.bw);
  const sl = sLat(values.lat);
  const sj = sJit(values.jit);
  const btn =
    'rounded-sm border border-slate-700 px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] text-slate-300 ' +
    'hover:border-cyan-700 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-700 disabled:hover:text-slate-300';

  return (
    <div className="flex flex-col gap-2 px-2.5 pb-2.5 pt-1" data-testid="link-shaping-panel" title={avail.title}>
      {locked && (
        <div className="flex items-center gap-1.5 rounded-sm border border-slate-800 bg-slate-950/50 px-2.5 py-2 text-[10px] leading-relaxed text-slate-400">
          <Lock className="h-3 w-3 flex-none" aria-hidden="true" />
          <span>{avail.title}</span>
        </div>
      )}

      <div className="flex items-center justify-between px-0.5 pt-1">
        <span className="text-[9px] tracking-[0.16em] text-slate-500">PROFILE</span>
        {custom && <span className="text-[9px] tracking-[0.14em] text-amber-300" data-testid="profile-custom">CUSTOM</span>}
      </div>

      {/* Fixed grid: four equal columns, every tile the same height, the
          selected state changes colour only (no border-width change, so no
          layout shift). */}
      <div
        role="radiogroup"
        aria-label="Link profile"
        className={`grid grid-cols-[repeat(2,minmax(0,1fr))] gap-1.5 min-[440px]:grid-cols-[repeat(4,minmax(0,1fr))] ${locked ? 'opacity-40' : ''}`}
      >
        {PRESETS.map((p, i) => {
          const on = i === cur;
          return (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={on}
              data-preset={p.name}
              disabled={locked}
              onClick={() => choose(i)}
              className={`relative flex h-full flex-col gap-2 overflow-hidden rounded-sm border px-2.5 pb-2 pt-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                on
                  ? 'border-cyan-400 bg-cyan-950/60'
                  : 'border-slate-700 bg-slate-950/50 enabled:hover:border-cyan-800'
              }`}
            >
              {on && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[2px] bg-cyan-400 shadow-[0_0_10px_#22d3ee]"
                />
              )}
              <span className="flex h-[14px] items-center justify-between gap-1.5">
                <b
                  className={`whitespace-nowrap text-[10px] font-bold tracking-[0.14em] ${
                    p.severed ? 'text-rose-300' : on ? 'text-cyan-200' : 'text-slate-200'
                  }`}
                >
                  {p.name}
                </b>
                <SignalBars lit={p.bars} color={p.color} />
              </span>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-1.5 gap-y-[3px] text-[10px] leading-[14px]">
                {presetRows(p).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="tracking-[0.1em] text-slate-500">{k}</dt>
                    <dd className="m-0 whitespace-nowrap text-right tabular-nums text-slate-300">{v}</dd>
                  </div>
                ))}
              </dl>
            </button>
          );
        })}
      </div>

      {!up && !locked && (
        <div className="rounded-sm border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-rose-300">
          Link severed. Shaping takes effect when the link is restored.
        </div>
      )}

      <div className={`flex flex-col gap-2 ${dimmed || locked ? 'opacity-40' : ''}`}>
        {/* BANDWIDTH LIMITER */}
        <div className="rounded-sm border border-slate-800 bg-slate-950/50 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Wifi className="h-4 w-4 flex-none text-emerald-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[11px] font-bold tracking-[0.14em] text-slate-200">BANDWIDTH LIMITER</span>
            <span
              data-badge="bw"
              className={`min-w-[82px] whitespace-nowrap rounded-sm border px-2 py-[3px] text-center text-[11px] font-bold ${BADGE[sb]}`}
            >
              {fbw(values.bw)}
            </span>
          </div>
          <input
            id={`${id}-bandwidth`}
            type="range"
            className="ddil-range"
            min={0}
            max={1000}
            step={1}
            value={position('bw')}
            style={sliderStyle(position('bw'), sb)}
            disabled={locked || dimmed}
            aria-label="Bandwidth"
            onChange={(e) => slide('bw', Number(e.target.value))}
          />
          <div className="mt-1 flex justify-between text-[9px] tracking-wide text-slate-500">
            <span>5 KB/s · SEVERE</span>
            <span>UNLIMITED · NOMINAL</span>
          </div>
        </div>

        {/* LATENCY & JITTER */}
        <div className="rounded-sm border border-slate-800 bg-slate-950/50 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Activity className="h-4 w-4 flex-none text-emerald-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[11px] font-bold tracking-[0.14em] text-slate-200">LATENCY &amp; JITTER</span>
            <span
              data-badge="lat"
              className={`min-w-[82px] whitespace-nowrap rounded-sm border px-2 py-[3px] text-center text-[11px] font-bold ${BADGE[sl]}`}
            >
              {fms(values.lat)}
            </span>
          </div>
          <input
            id={`${id}-latency`}
            type="range"
            className="ddil-range"
            min={0}
            max={1000}
            step={1}
            value={position('lat')}
            style={sliderStyle(position('lat'), sl)}
            disabled={locked || dimmed}
            aria-label="Latency"
            onChange={(e) => slide('lat', Number(e.target.value))}
          />
          <div className="mt-1.5 grid grid-cols-[62px_minmax(0,1fr)_82px] items-center gap-2.5 text-[9px] tracking-[0.12em] text-slate-500">
            <span>JITTER</span>
            <input
              id={`${id}-jitter`}
              type="range"
              className="ddil-range thin"
              min={0}
              max={1000}
              step={1}
              value={position('jit')}
              style={sliderStyle(position('jit'), sj)}
              disabled={locked || dimmed}
              aria-label="Jitter"
              onChange={(e) => slide('jit', Number(e.target.value))}
            />
            <span data-badge="jit" className="whitespace-nowrap text-center text-[10px] text-slate-300">
              {fjit(values.jit)}
            </span>
          </div>
          <div className="mt-1 flex justify-between text-[9px] tracking-wide text-slate-500">
            <span>0 ms · NOMINAL</span>
            <span>60 s · SEVERE</span>
          </div>
        </div>

        {/* PACKET SLICER: the PEP has no slicer yet. Display only -- this
            control is permanently disabled and nothing here can send it. */}
        <div className="rounded-sm border border-slate-800 bg-slate-950/50 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Zap className="h-4 w-4 flex-none text-slate-500" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[11px] font-bold tracking-[0.14em] text-slate-200">
              PACKET SLICER
              <small className="mt-0.5 block text-[9px] font-normal tracking-normal text-slate-500">
                Erratic chunks with micro-delays
              </small>
            </span>
            <span className="whitespace-nowrap rounded-sm border border-dashed border-slate-600 px-[5px] py-[2px] text-[8px] tracking-[0.12em] text-slate-400">
              NOT IN PEP YET
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label="Packet slicer"
              disabled
              className="relative h-[18px] w-[34px] flex-none cursor-not-allowed rounded-sm border border-slate-700 bg-slate-800 opacity-45"
            >
              <span className="absolute left-[2px] top-[2px] h-3 w-3 rounded-[1px] bg-slate-400" />
            </button>
          </div>
        </div>
      </div>

      {rejected && (
        <div role="alert" className="rounded-sm border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[10px] text-rose-300">
          A value is outside the allowed range and was not sent.
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span
          data-testid="shaping-state"
          className={`text-[10px] ${dirty ? 'text-cyan-200' : 'text-slate-500'}`}
        >
          {dirty ? '● Unsaved changes' : 'Applied'}
        </span>
        <span className="flex gap-1.5">
          <button type="button" className={btn} disabled={locked} title={avail.title} onClick={clear}>CLEAR</button>
          <button
            type="button"
            disabled={locked}
            title={avail.title}
            onClick={apply}
            className={`rounded-sm border border-cyan-700 bg-cyan-950/60 px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] text-cyan-200 hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 ${
              dirty ? 'shadow-[0_0_0_1px_#22d3ee,0_0_14px_rgba(34,211,238,0.25)]' : ''
            }`}
          >
            APPLY
          </button>
        </span>
      </div>
    </div>
  );
}
