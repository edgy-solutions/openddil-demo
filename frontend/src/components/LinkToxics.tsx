// LinkToxics — latency, jitter and bandwidth for one link, beside its toggle.
//
// The fields mirror the link's APPLIED toxics (from the listing) until the
// user edits one; SET sends the complete state for the link, CLR sends all
// zeros. A slow link is still up: nothing here touches reachability. The
// amber labels are the at-a-glance "this link is degraded" cue.
import { useState } from 'react';
import { linkToxicsAvailability } from '../lib/linkControl';
import type { LinkControlStatus, LinkToxics } from '../lib/linkControl';

type Field = keyof LinkToxics;

// The PEP's bounds; a value outside them is refused there, so refuse it here.
const FIELDS: ReadonlyArray<{ key: Field; label: string; suffix: string; max: number }> = [
  { key: 'latency_ms', label: 'LAT', suffix: 'latency', max: 60000 },
  { key: 'jitter_ms', label: 'JIT', suffix: 'jitter', max: 60000 },
  { key: 'bandwidth_kb_s', label: 'BW', suffix: 'bandwidth', max: 1000000 },
];

const UNITS: Record<Field, string> = {
  latency_ms: 'ms',
  jitter_ms: 'ms',
  bandwidth_kb_s: 'KB/s',
};

function mirror(toxics: LinkToxics | null): Record<Field, string> {
  const show = (n: number | undefined) => (n ? String(n) : '');
  return {
    latency_ms: show(toxics?.latency_ms),
    jitter_ms: show(toxics?.jitter_ms),
    bandwidth_kb_s: show(toxics?.bandwidth_kb_s),
  };
}

export interface LinkToxicsControlProps {
  /** Unique DOM id prefix (label wiring). */
  id: string;
  /** The applied state from the listing; null = unknown. */
  toxics: LinkToxics | null;
  status: LinkControlStatus;
  onApply: (t: LinkToxics) => void;
}

export function LinkToxicsControl({ id, toxics, status, onApply }: LinkToxicsControlProps) {
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set());
  const avail = linkToxicsAvailability(status, toxics);
  if (!avail.show) return null;

  const values = draft ?? mirror(toxics);
  const degraded = !!toxics && (toxics.latency_ms > 0 || toxics.jitter_ms > 0 || toxics.bandwidth_kb_s > 0);
  const labelClass = degraded ? 'text-amber-400' : 'text-slate-400';

  function edit(key: Field, value: string) {
    setDraft({ ...values, [key]: value });
    setInvalid((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function apply() {
    const out: LinkToxics = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };
    const bad = new Set<Field>();
    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      if (raw === '') continue;
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > f.max) bad.add(f.key);
      else out[f.key] = n;
    }
    setInvalid(bad);
    if (bad.size > 0) return;
    onApply(out);
    setDraft(null);
  }

  function clear() {
    onApply({ latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 });
    setDraft(null);
    setInvalid(new Set());
  }

  const btn =
    'px-1 border border-slate-600 text-slate-300 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed';
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-widest" title={avail.title}>
      {FIELDS.map((f) => (
        <span key={f.key} className="inline-flex items-center gap-0.5">
          <label htmlFor={`${id}-${f.suffix}`} className={labelClass} title={UNITS[f.key]}>
            {f.label}
          </label>
          <input
            type="number"
            min={0}
            id={`${id}-${f.suffix}`}
            className={`w-12 bg-slate-900 text-slate-200 border px-0.5 disabled:opacity-50 ${invalid.has(f.key) ? 'border-rose-500' : 'border-slate-700'}`}
            placeholder="0"
            value={values[f.key]}
            disabled={avail.disabled}
            title={avail.title}
            onChange={(e) => edit(f.key, e.target.value)}
          />
        </span>
      ))}
      <button type="button" className={btn} disabled={avail.disabled} title={avail.title} onClick={apply}>SET</button>
      <button type="button" className={btn} disabled={avail.disabled} title={avail.title} onClick={clear}>CLR</button>
    </span>
  );
}
