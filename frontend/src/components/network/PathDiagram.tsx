// =============================================================================
// PathDiagram pieces — nodes, wires, the buffer block and section headings
// =============================================================================
// Presentation only. Each header decides WHICH nodes to show (an edge shows
// itself and its parent and nothing beyond; HQ keeps its declared topology) and
// passes in the wire tones, which must come from observed state (network/tone).
import type { ComponentType, ReactNode } from 'react';
import { TrendingUp } from 'lucide-react';
import type { Tone } from './tone';
import './network.css';

const WIRE: Record<Tone, string> = {
  ok: 'ddil-wire-up bg-gradient-to-r from-emerald-900 via-emerald-500 to-emerald-900',
  warn: 'bg-gradient-to-r from-amber-900 via-amber-500 to-amber-900',
  bad: 'bg-[repeating-linear-gradient(90deg,#f43f5e_0_6px,transparent_6px_10px)]',
  neutral: 'bg-slate-700',
};

export function PathRow({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-1.5 px-3.5 pb-1 pt-3">{children}</div>;
}

export function PathNode({
  icon: Icon, label, me = false, badge,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** This is the node the viewer is on. */
  me?: boolean;
  /** Rendered after the label (ThisNodeBadge renders nothing unless true). */
  badge?: ReactNode;
}) {
  return (
    <div className={`flex w-[84px] flex-none flex-col items-center gap-1 text-center text-[9px] font-bold tracking-[0.12em] ${me ? 'text-emerald-300' : 'text-slate-500'}`}>
      <Icon className={me ? 'h-[22px] w-[22px] text-emerald-400 glow-emerald' : 'h-[22px] w-[22px] text-slate-500'} />
      <span>{label}{badge}</span>
    </div>
  );
}

export function Wire({ tone, label, testId }: { tone: Tone; label?: string; testId?: string }) {
  return (
    <div className="relative mt-[11px] h-[2px] min-w-0 flex-1" data-testid={testId}>
      {label && (
        <span className="absolute bottom-full left-0 right-0 mb-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-center text-[8px] tracking-widest text-slate-500">
          {label}
        </span>
      )}
      <div data-tone={tone} className={`relative h-full w-full rounded-[1px] ${WIRE[tone]}`} />
    </div>
  );
}

/** The line that goes AROUND the middle node (HQ's direct leaf links): from
 *  the first node's centre, under the hub, up into the last node's centre. */
export function DirectArc({ tone, testId }: { tone: Tone; testId?: string }) {
  const color: Record<Tone, string> = {
    ok: 'border-emerald-600', warn: 'border-amber-500', bad: 'border-rose-500 border-dashed', neutral: 'border-slate-700',
  };
  return (
    <div className="px-3.5">
      <div
        data-testid={testId}
        data-tone={tone}
        className={`mx-[42px] -mt-1 h-4 rounded-b-sm border-x-2 border-b-2 ${color[tone]}`}
      />
    </div>
  );
}

/** Buffer depth: big number, its label and a trend arrow. `severed` only
 *  recolours the arrow; callers pass the OBSERVED indicator's verdict. */
export function BufferBlock({
  label, value, lag, severed,
}: { label: string; value: string; lag: number; severed: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3.5 pb-2.5 pt-1.5">
      <span className="text-3xl font-bold tabular-nums text-slate-100" data-testid="buffer-value">{value}</span>
      <span className="text-xs text-slate-500">MSGS</span>
      <TrendingUp
        className={`h-4 w-4 self-center transition-all ${lag === 0 ? 'opacity-0' : 'opacity-100'} ${severed ? 'text-rose-500' : 'rotate-180 text-emerald-500'}`}
        aria-hidden="true"
      />
      <span className="basis-full text-[10px] tracking-wider text-slate-400">{label}</span>
    </div>
  );
}

export function Section({
  title, testId, children,
}: { title: string; testId?: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="border-t border-slate-800">
      <h3 className="px-3.5 pb-0.5 pt-2 text-[9px] font-normal tracking-[0.16em] text-slate-500">{title}</h3>
      <div className="flex flex-col gap-1 px-2 pb-2 pt-1">{children}</div>
    </section>
  );
}

/** The observed link label (and, beside it, any control caption). */
export function StatusStrip({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-3.5 pb-1 pt-1">{children}</div>;
}
