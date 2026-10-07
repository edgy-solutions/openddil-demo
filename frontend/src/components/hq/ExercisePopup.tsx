// =============================================================================
// ExercisePopup — the HQ header's "Exercise" button and its control popup
// =============================================================================
// Split into a stateful container (this default export: owns
// useExerciseControl's polling plus the popup's own open/confirm state)
// and a pure view (ExercisePopupView, exported separately) for the same
// reason ManualQuestionPanel and FaultReportForm are split: the view is
// testable with react-dom/server's renderToStaticMarkup (no DOM dependency
// in this project -- see vitest.config.ts); the container's polling is not
// unit-tested directly, same as useWanLink's.
//
// THE RULE THIS COMPONENT MUST NEVER BREAK: nothing
// here ever renders a claim about the simulator's running/paused state
// drawn from `last_command`. The activity badge is built ONLY from
// `status.activity`; "Last command sent" is worded as a send (op, time,
// outcome, subject), never as a state.
import { useState } from 'react';
import { useExerciseControl } from '../../hooks/useExerciseControl';
import type { ExerciseActivity, ExerciseLastCommand, ExerciseReset } from '../../lib/exerciseControl';

// Ops whose effect is disruptive enough to ask once before sending --
// starting or losing the running simulator, not merely pausing/resuming it.
const CONFIRM_OPS = new Set(['stop', 'restart']);

export interface ExercisePopupViewProps {
  kind: 'absent' | 'forbidden' | 'ok' | 'loading';
  ops: string[];
  activity: ExerciseActivity | null;
  lastCommand: ExerciseLastCommand | null;
  reset: ExerciseReset | null;
  open: boolean;
  onToggleOpen: () => void;
  pendingConfirmOp: string | null;
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
  const outcome = cmd.error ? cmd.error : String(cmd.status ?? 'no response');
  return `Last command sent: ${cmd.op} at ${cmd.at} -> ${outcome} by ${cmd.subject}`;
}

function resetText(reset: ExerciseReset | null): string {
  if (!reset || !reset.measured_zero_at) return 'no measured zero on record';
  return `Reset required before restart: last measured zero at ${reset.measured_zero_at}`;
}

export function ExercisePopupView({
  kind, ops, activity, lastCommand, reset, open, onToggleOpen,
  pendingConfirmOp, onOpClick, onConfirm, onCancelConfirm,
}: ExercisePopupViewProps) {
  if (kind === 'absent' || kind === 'loading') return null;

  const forbidden = kind === 'forbidden';

  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        disabled={forbidden}
        title={forbidden ? 'Exercise control: supervisor only' : undefined}
        onClick={forbidden ? undefined : onToggleOpen}
        className="text-[10px] font-bold tracking-widest px-2 py-1 border border-slate-600 rounded disabled:cursor-not-allowed disabled:opacity-50"
      >
        EXERCISE
      </button>
      {forbidden && (
        <span className="text-[9px] mt-0.5 text-slate-500 tracking-widest">
          Exercise control: supervisor only
        </span>
      )}

      {!forbidden && open && (
        <div className="absolute top-full mt-2 w-72 p-3 bg-slate-900 border border-slate-700 rounded z-20 text-left">
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
            {ops.map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => onOpClick(op)}
                className="text-[10px] px-2 py-1 border border-slate-600 rounded"
              >
                {op}
              </button>
            ))}
          </div>

          {pendingConfirmOp && (
            <div className="mt-2 text-[10px] text-amber-400">
              Confirm {pendingConfirmOp}?
              <button type="button" onClick={onConfirm} className="ml-2 underline">yes</button>
              <button type="button" onClick={onCancelConfirm} className="ml-2 underline">cancel</button>
            </div>
          )}

          <div className="mt-2 text-[10px] text-slate-300">{lastCommandText(lastCommand)}</div>
          <div className="mt-1 text-[10px] text-slate-300">{resetText(reset)}</div>
          <div className="mt-1 text-[9px] text-slate-500">
            Restart is two halves: stop here, then an operator runs the reset elsewhere, then restart and run here.
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExercisePopup() {
  const { kind, status, runOp } = useExerciseControl();
  const [open, setOpen] = useState(false);
  const [pendingConfirmOp, setPendingConfirmOp] = useState<string | null>(null);

  function handleOpClick(op: string): void {
    if (CONFIRM_OPS.has(op)) {
      setPendingConfirmOp(op);
      return;
    }
    runOp(op);
  }

  function handleConfirm(): void {
    if (pendingConfirmOp) runOp(pendingConfirmOp);
    setPendingConfirmOp(null);
  }

  return (
    <ExercisePopupView
      kind={kind}
      ops={status?.adapter.ops ?? []}
      activity={status?.activity ?? null}
      lastCommand={status?.last_command ?? null}
      reset={status?.reset ?? null}
      open={open}
      onToggleOpen={() => setOpen((v) => !v)}
      pendingConfirmOp={pendingConfirmOp}
      onOpClick={handleOpClick}
      onConfirm={handleConfirm}
      onCancelConfirm={() => setPendingConfirmOp(null)}
    />
  );
}
