// =============================================================================
// ExercisePopup — the HQ header's exercise pill and its control popover
// =============================================================================
// Split into a stateful container (this default export: owns
// useExerciseControl's polling plus the popover's own open/confirm state and
// document listeners) and a pure view (ExercisePopupView, exported
// separately) for the same reason ManualQuestionPanel and FaultReportForm are
// split: the view is testable with react-dom/server's renderToStaticMarkup
// (no DOM dependency in this project -- see vitest.config.ts); the
// container's polling is not unit-tested directly, same as useLinkControl's.
// Look and behaviour follow the network pill (network/NetworkPopover.tsx).
//
// THE RULE THIS COMPONENT MUST NEVER BREAK: nothing
// here ever renders a claim about the simulator's running/paused state
// drawn from `last_command`. The pill state and the activity badge are built
// ONLY from `status.activity` (and `reset_job.latest`); "Last command sent"
// is worded as a send (op, time, outcome, subject), never as a state.
import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react';
import {
  ChevronDown, CircleHelp, Pause, Play, Rewind, RotateCcw, Square, StepForward, X,
  type LucideIcon,
} from 'lucide-react';
import { useExerciseControl } from '../../hooks/useExerciseControl';
import { resetConfirmBody, type ResetPreflightView } from '../../lib/exerciseControl';
import type {
  ExerciseActivity, ExerciseLastCommand, ExerciseLoop, ExerciseReset, ExerciseResetJob, ExerciseSequence,
  ExerciseSequenceRun, ExerciseSequenceStep,
} from '../../lib/exerciseControl';
import type { Tone } from '../network/tone';

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_8px_#34d399]',
  warn: 'bg-amber-400 shadow-[0_0_8px_#f59e0b]',
  bad: 'bg-rose-500 shadow-[0_0_8px_#f43f5e]',
  neutral: 'bg-slate-500',
};

// Ops whose effect is disruptive enough to ask once before sending --
// starting or losing the running simulator, not merely pausing/resuming it.
const CONFIRM_OPS = new Set(['stop', 'restart', 'reset', 'loop']);

const OP_BUTTON =
  'inline-flex items-center gap-1 rounded-full border border-slate-700 px-2.5 py-1 text-[10px] tracking-wider text-slate-200 hover:border-cyan-700 hover:bg-cyan-950/30';

const OP_VIEW: Record<string, { icon: LucideIcon; label: string }> = {
  run: { icon: Play, label: 'Run' },
  pause: { icon: Pause, label: 'Pause' },
  resume: { icon: StepForward, label: 'Resume' },
  stop: { icon: Square, label: 'Stop' },
  restart: { icon: RotateCcw, label: 'Restart' },
};

export interface PillState {
  icon: LucideIcon;
  word: string;
  tone: Tone;
  title?: string;
}

/** Pill state: drawn ONLY from `activity` and `resetJob.latest`, never from
 *  `last_command`. Measurement cannot tell paused from stopped, so the
 *  no-PDU state reads IDLE. */
// eslint-disable-next-line react-refresh/only-export-components -- pure function exported for tests; costs only HMR granularity
export function pillState(
  activity: ExerciseActivity | null | undefined,
  resetJob?: ExerciseResetJob | null,
): PillState {
  if (resetJob?.latest?.state === 'running') {
    return { icon: Rewind, word: 'RESETTING', tone: 'warn' };
  }
  if (activity?.state === 'running') return { icon: Play, word: 'RUNNING', tone: 'ok' };
  if (activity?.state === 'paused') {
    return { icon: Square, word: 'IDLE', tone: 'warn', title: 'no entity PDUs (paused or stopped)' };
  }
  return { icon: CircleHelp, word: 'UNKNOWN', tone: 'neutral' };
}

export interface ExercisePopupViewProps {
  kind: 'absent' | 'forbidden' | 'ok' | 'loading';
  ops: string[];
  activity: ExerciseActivity | null;
  lastCommand: ExerciseLastCommand | null;
  reset: ExerciseReset | null;
  resetJob?: ExerciseResetJob | null;
  sequences?: ExerciseSequence[] | null;
  sequence?: ExerciseSequenceRun | null;
  loop?: ExerciseLoop | null;
  refusal?: string | null;
  stale?: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  rootRef?: Ref<HTMLDivElement>;
  pillRef?: Ref<HTMLButtonElement>;
  pendingConfirmOp: string | null;
  /** Pre-flight of the pending reset; null when no reset confirm is pending. */
  resetPreflight?: ResetPreflightView | null;
  onOpClick: (op: string) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}

function activityBadgeText(activity: ExerciseActivity | null): string {
  if (!activity) return 'Unknown';
  if (activity.state === 'running') return 'Running';
  if (activity.state === 'paused') return `Paused (${activity.label})`;
  return 'Unknown';
}

function lastCommandText(cmd: ExerciseLastCommand | null): string {
  if (!cmd) return 'No command sent yet';
  if (cmd.sequence) return `${cmd.op} started by ${cmd.subject} at ${cmd.at} (sequence)`;
  const outcome = cmd.error ? cmd.error : String(cmd.status ?? 'no response');
  return `Last command sent: ${cmd.op} at ${cmd.at} -> ${outcome} by ${cmd.subject}`;
}

function clock(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function minutes(s: number): number {
  return Math.round(s / 60);
}

/** One line of loop state, built only from the served `loop` object. */
function loopLineText(loop: ExerciseLoop): string {
  if (loop.state === 'halted' && loop.halt) {
    const kind = loop.halt.step.split(':')[0];
    return `Halted at cycle ${loop.halt.cycle}, step ${kind}: ${loop.halt.detail}`;
  }
  if (loop.state === 'stopping') {
    const inReset = loop.step?.startsWith('reset') ? ' (reset in progress)' : '';
    return `Cycle ${loop.cycle} · stopping${inReset}`;
  }
  if (loop.state === 'running') {
    const aw = loop.await;
    if (aw) {
      const quiet = aw.armed ? `quiet ${aw.quiet_s}/${aw.quiet_needed_s} s` : 'no fire seen yet';
      return `Cycle ${loop.cycle} · running · awaiting scenario end — ${quiet} · fallback in ${clock(aw.fallback_remaining_s)}`;
    }
    return `Cycle ${loop.cycle} · running · ${loop.step ?? 'starting'}`;
  }
  if (loop.state === 'stopped') return `Loop stopped at cycle ${loop.cycle}`;
  return 'Loop idle';
}

function resetText(reset: ExerciseReset | null): string {
  if (!reset || !reset.measured_zero_at) return 'no measured zero on record';
  return `Reset required before restart: last measured zero at ${reset.measured_zero_at}`;
}

function resetJobText(job: ExerciseResetJob | null | undefined): string {
  const latest = job?.latest;
  if (!latest) return 'Reset job: none yet';
  const done = latest.finished_at ? ` (${latest.finished_at})` : '';
  const what = job?.mode === 'quick' ? 'Quick reset job' : 'Reset job';
  return `${what} ${latest.name}: ${latest.state}${done}`;
}

/** Host (and port) of a call's URL; never the path or query. */
function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function stepText(st: ExerciseSequenceStep): string {
  if (st.name) return st.name;
  if (st.kind === 'wait') return `wait ${st.wait_s ?? 0} s`;
  return `${st.method ?? ''} ${hostOf(st.url)}`.trim();
}

function SequenceRunPanel({ run }: { run: ExerciseSequenceRun }) {
  const haltedAt = run.state === 'halted'
    ? (run.steps.find((st) => st.state === 'failed') ?? run.steps.find((st) => st.state === 'skipped'))
    : undefined;
  return (
    <div className="mt-2 text-[10px] text-slate-300" data-testid="exercise-sequence-run" data-state={run.state}>
      <div>
        <span className="font-bold">{run.label}</span> {run.state} by {run.subject}
      </div>
      <div className="text-slate-500">
        started {run.started_at}
        {run.finished_at ? `, finished ${run.finished_at}` : ''}
      </div>
      <ul className="mt-1">
        {run.steps.map((st) => (
          <li key={st.i} data-testid="exercise-sequence-step" data-i={st.i} data-state={st.state}>
            {stepText(st)}: {st.state}
            {st.state === 'failed' && (st.status !== null || st.error) && (
              <span className="text-amber-400">
                {st.status !== null ? ` ${st.status}` : ''}{st.error ? ` ${st.error}` : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
      {run.state === 'halted' && (
        <div className="mt-1 text-amber-400">
          halted at step {haltedAt ? haltedAt.i : '?'}: later steps were skipped; nothing was undone
        </div>
      )}
    </div>
  );
}

function ResetPreflightNote({ view }: { view: ResetPreflightView | null }) {
  if (!view || view.kind === 'loading') {
    return <div className="mt-0.5" data-testid="exercise-preflight">Counting open Restate work…</div>;
  }
  if (view.kind === 'unavailable') {
    return (
      <div className="mt-0.5" data-testid="exercise-preflight">
        Restate count unavailable — the reset may stop at its pre-flight
      </div>
    );
  }
  const pf = view.preflight;
  if (pf.needs_confirmation) {
    return (
      <div className="mt-0.5" data-testid="exercise-preflight">
        {pf.runtimes.filter((r) => pf.over.includes(r.name)).map((r) => (
          <div key={r.name}>{r.name}: {r.open} open (limit {pf.limit})</div>
        ))}
        <div>
          The cancel is bounded in time; if it runs out the reset halts with the count left.
        </div>
      </div>
    );
  }
  const total = pf.runtimes.reduce((n, r) => n + (r.open ?? 0), 0);
  return (
    <div className="mt-0.5" data-testid="exercise-preflight">
      Open Restate invocations: {total} (limit {pf.limit})
    </div>
  );
}

export function ExercisePopupView({
  kind, ops, activity, lastCommand, reset, resetJob, sequences, sequence, loop, refusal, stale, open, onToggleOpen,
  onClose, rootRef, pillRef, pendingConfirmOp, resetPreflight, onOpClick, onConfirm, onCancelConfirm,
}: ExercisePopupViewProps) {
  const popId = useId();
  if (kind === 'absent' || kind === 'loading') return null;

  const forbidden = kind === 'forbidden';
  const resetAvailable = resetJob?.available === true;
  // An older gateway omits may_press; only an explicit false disables.
  const resetBlocked = resetJob?.may_press === false;
  const quickReset = resetJob?.mode === 'quick';
  const resetLabel = quickReset ? 'Quick reset' : 'Restart exercise';
  const loopShown = loop?.configured === true;
  const loopBusy = loopShown && (loop.state === 'running' || loop.state === 'stopping');
  const loopStartBlocked = resetBlocked || loopBusy || sequence?.state === 'running';
  const busyTitle = loopBusy ? 'loop running' : undefined;
  const sequenceList = sequences ?? [];
  const sequenceRunning = sequence?.state === 'running';
  const pendingSequence = sequenceList.find((q) => q.name === pendingConfirmOp);
  const resetLoading = pendingConfirmOp === 'reset' && resetPreflight?.kind === 'loading';
  const overBody = pendingConfirmOp === 'reset' ? resetConfirmBody(resetPreflight ?? null) : undefined;
  const overLimit = overBody && resetPreflight?.kind === 'ready' ? resetPreflight.preflight : null;

  const ps: PillState = forbidden
    ? { icon: CircleHelp, word: 'EXERCISE', tone: 'neutral' }
    : pillState(activity, resetJob);
  const Icon = ps.icon;
  let title = forbidden ? 'Exercise control: not authorised' : ps.title;
  if (stale && !forbidden) title = title ? `${title} (status stale)` : 'status stale';
  // Forbidden must never open the panel, even if open=true is passed.
  const showPanel = !forbidden && open;

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        ref={pillRef}
        type="button"
        data-testid="exercise-pill"
        data-state={ps.word}
        disabled={forbidden}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={showPanel}
        aria-controls={showPanel ? popId : undefined}
        onClick={forbidden ? undefined : onToggleOpen}
        className={`flex items-center h-7 gap-2.5 rounded-full border py-0.5 pl-3 pr-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          showPanel
            ? 'border-cyan-700 bg-cyan-950/40'
            : 'border-slate-700 bg-transparent hover:border-cyan-700 hover:bg-cyan-950/30'
        }${stale ? ' opacity-60' : ''}`}
      >
        <span className={`h-[7px] w-[7px] rounded-full ${DOT[ps.tone]}`} />
        {forbidden ? (
          <span className="text-[10px] font-bold tracking-widest pr-3">{ps.word}</span>
        ) : (
          <>
            <span className="text-[10px] tracking-widest text-slate-500">SIM</span>
            <Icon className="h-3 w-3" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-widest">{ps.word}</span>
            <span className={`grid h-5 w-5 place-items-center rounded-full bg-slate-800 transition-transform duration-200 ${showPanel ? 'rotate-180' : ''}`}>
              <ChevronDown className="h-3 w-3 text-slate-300" aria-hidden="true" />
            </span>
          </>
        )}
      </button>

      {showPanel && (
        <div
          id={popId}
          role="dialog"
          aria-label="Exercise"
          data-testid="exercise-panel"
          style={{ width: 'min(360px, calc(100vw - 24px))' }}
          className="absolute right-0 top-full z-50 mt-2 max-h-[min(80vh,calc(100vh-120px))] overflow-y-auto rounded-sm border border-cyan-400/20 bg-[rgba(8,14,26,0.92)] text-left shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between px-3.5 pt-3">
            <span className="text-[9px] tracking-[0.16em] text-slate-500">EXERCISE</span>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid h-6 w-6 place-items-center rounded-sm text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
          <div className="px-3.5 pb-3">
            <div className="text-sm font-bold text-slate-100">{activityBadgeText(activity)}</div>
            <div className="text-[10px] text-slate-400">
              from entity PDU rate over {activity ? activity.window_s : 30} s
            </div>
            <ul className="mt-1 text-[10px] text-slate-500">
              {(activity?.sources ?? []).map((s) => (
                <li key={s.url}>
                  {s.url}: {s.reachable ? `${s.rate ?? 'measuring'} pdu/s` : 'unreachable'}
                </li>
              ))}
            </ul>

            <div className="mt-2 flex flex-wrap gap-1">
              {ops.map((op) => {
                const v = OP_VIEW[op];
                const OpIcon = v?.icon;
                return (
                  <button
                    key={op}
                    type="button"
                    disabled={loopBusy}
                    title={busyTitle}
                    onClick={loopBusy ? undefined : () => onOpClick(op)}
                    className={`${OP_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {OpIcon && <OpIcon className="h-3 w-3" aria-hidden="true" />}
                    {v?.label ?? op}
                  </button>
                );
              })}
            </div>

            {resetAvailable && (
              <div className="mt-2">
                <button
                  type="button"
                  disabled={resetBlocked || loopBusy}
                  title={
                    loopBusy
                      ? 'loop running'
                      : quickReset
                      ? 'Clears exercise data in about a minute. Not measured; the exercise stays paused afterwards.'
                      : resetBlocked
                        ? 'The reset destroys exercise state and takes about 13 minutes.'
                        : undefined
                  }
                  onClick={resetBlocked || loopBusy ? undefined : () => onOpClick('reset')}
                  className={`${OP_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Rewind className="h-3 w-3" aria-hidden="true" />
                  {resetLabel}
                </button>
                {resetBlocked && (
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {resetLabel}: supervisor login only
                  </div>
                )}
              </div>
            )}

            {sequenceList.length > 0 && (
              <div className="mt-2">
                <div className="flex flex-wrap gap-1">
                  {sequenceList.map((q) => {
                    const disabled = q.may_press === false || sequenceRunning || loopBusy;
                    const desc = q.description ? `${q.description} ` : '';
                    return (
                      <button
                        key={q.name}
                        type="button"
                        data-testid="exercise-sequence-button"
                        data-op={q.name}
                        disabled={disabled}
                        title={loopBusy ? 'loop running' : `${desc}(${q.steps} steps, about ${q.total_wait_s} s)`}
                        onClick={disabled ? undefined : () => onOpClick(q.name)}
                        className={`${OP_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        {q.label}
                      </button>
                    );
                  })}
                </div>
                {sequenceList.filter((q) => q.may_press === false).map((q) => (
                  <div key={q.name} className="mt-0.5 text-[10px] text-slate-500">
                    {q.label}: supervisor login only
                  </div>
                ))}
                {sequenceRunning && (
                  <div className="mt-0.5 text-[10px] text-slate-500">a sequence is running</div>
                )}
              </div>
            )}

            {sequence && <SequenceRunPanel run={sequence} />}

            {loop && loopShown && (
              <div className="mt-2 text-[10px] text-slate-300" data-testid="exercise-loop" data-state={loop.state}>
                <div className="text-[9px] tracking-[0.16em] text-slate-500">LOOP</div>
                <div data-testid="exercise-loop-line">{loopLineText(loop)}</div>
                {loop.state === 'running' && loop.await && (
                  <div className="text-slate-500">
                    {`ends after ${minutes(loop.await.quiet_needed_s)} min quiet, or at the ${minutes(loop.await.fallback_s)}-min fallback`}
                  </div>
                )}
                {loop.last_cycle?.end_reason === 'fallback' && (
                  <div className="text-amber-400">
                    {`Cycle ${loop.last_cycle.cycle} ended by the ${minutes(loop.fallback_s ?? loop.await?.fallback_s ?? 0)}-minute fallback (no quiet seen)`}
                  </div>
                )}
                {loop.record_error && (
                  <div className="text-amber-400">{`Cycle record not saved: ${loop.record_error}`}</div>
                )}
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    data-testid="exercise-loop-start"
                    disabled={loopStartBlocked}
                    onClick={loopStartBlocked ? undefined : () => onOpClick('loop')}
                    className={`${OP_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    Start loop
                  </button>
                  <button
                    type="button"
                    data-testid="exercise-loop-stop"
                    disabled={loop.state !== 'running'}
                    onClick={loop.state === 'running' ? () => onOpClick('loopstop') : undefined}
                    className={`${OP_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    Stop loop
                  </button>
                </div>
                {resetBlocked && (
                  <div className="mt-0.5 text-slate-500">Loop: supervisor login only</div>
                )}
              </div>
            )}

            {pendingConfirmOp && (
              <div className="mt-2 text-[10px] text-amber-400">
                {pendingConfirmOp === 'reset'
                  ? quickReset
                    ? 'Quick reset: pause the exercise and clear its data (not measured)? It stays paused; press Resume or Restart when ready.'
                    : 'Restart exercise: reset (deletes scenario state), then restart?'
                  : pendingConfirmOp === 'loop'
                    ? 'Start the exercise loop? It repeats the configured steps, including resets, until stopped.'
                  : pendingSequence
                    ? `${pendingSequence.label}: run the sequence? It changes the exercise for every viewer.`
                    : `Confirm ${pendingConfirmOp}?`}
                {!resetLoading && (
                  <button type="button" onClick={onConfirm} className="ml-2 underline" data-testid="exercise-confirm">
                    {overLimit ? `Cancel ${overLimit.open_over} open invocations and reset` : 'yes'}
                  </button>
                )}
                <button type="button" onClick={onCancelConfirm} className="ml-2 underline">cancel</button>
                {pendingConfirmOp === 'reset' && resetPreflight && <ResetPreflightNote view={resetPreflight} />}
              </div>
            )}

            <div className="mt-2 text-[10px] text-slate-300">{lastCommandText(lastCommand)}</div>
            <div className="mt-1 text-[10px] text-slate-300">{resetText(reset)}</div>
            {resetAvailable && (
              <div className="mt-1 text-[10px] text-slate-300">{resetJobText(resetJob)}</div>
            )}
            {refusal && <div className="mt-1 text-[10px] text-amber-400">Refused: {refusal}</div>}
            <div className="mt-1 text-[9px] text-slate-500">
              {resetAvailable && quickReset
                ? 'Quick reset clears the exercise data in the cluster and leaves the exercise paused.'
                : resetAvailable
                ? 'Restart exercise runs the reset in the cluster, then sends restart only if the reset measured zero.'
                : 'Restart is two halves: stop here, then an operator runs the reset, then restart and run here.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExercisePopup() {
  const { kind, status, stale, refusal, runOp, resetPreflight } = useExerciseControl();
  const [open, setOpen] = useState(false);
  const [pendingConfirmOp, setPendingConfirmOp] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ResetPreflightView | null>(null);
  const preflightSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPendingConfirmOp(null);
    setPreflight(null);
    preflightSeq.current += 1;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      pillRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  function handleOpClick(op: string): void {
    if (CONFIRM_OPS.has(op) || (status?.sequences ?? []).some((q) => q.name === op)) {
      setPendingConfirmOp(op);
      if (op === 'reset') {
        // Count the open Restate work first; a late answer for an earlier
        // press (or a cancelled confirm) is dropped.
        const seq = ++preflightSeq.current;
        setPreflight({ kind: 'loading' });
        void resetPreflight().then((view) => {
          if (preflightSeq.current === seq) setPreflight(view);
        });
      }
      return;
    }
    runOp(op);
  }

  function handleConfirm(): void {
    if (pendingConfirmOp === 'reset') {
      runOp('reset', resetConfirmBody(preflight));
    } else if (pendingConfirmOp) {
      runOp(pendingConfirmOp);
    }
    setPendingConfirmOp(null);
    setPreflight(null);
    preflightSeq.current += 1;
  }

  function handleCancelConfirm(): void {
    setPendingConfirmOp(null);
    setPreflight(null);
    preflightSeq.current += 1;
  }

  return (
    <ExercisePopupView
      kind={kind}
      ops={status?.adapter.ops ?? []}
      activity={status?.activity ?? null}
      lastCommand={status?.last_command ?? null}
      reset={status?.reset ?? null}
      resetJob={status?.reset_job ?? null}
      sequences={status?.sequences ?? null}
      sequence={status?.sequence ?? null}
      loop={status?.loop ?? null}
      refusal={refusal}
      stale={stale}
      open={open}
      onToggleOpen={() => (open ? close() : setOpen(true))}
      onClose={() => { close(); pillRef.current?.focus(); }}
      rootRef={rootRef}
      pillRef={pillRef}
      pendingConfirmOp={pendingConfirmOp}
      resetPreflight={preflight}
      onOpClick={handleOpClick}
      onConfirm={handleConfirm}
      onCancelConfirm={handleCancelConfirm}
    />
  );
}
