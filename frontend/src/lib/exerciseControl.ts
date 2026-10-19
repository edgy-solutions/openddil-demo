// =============================================================================
// exerciseControl — the exercise-control popup's commanded/observed state
// =============================================================================
// Pattern: lib/linkControl.ts. A framework-free controller (tested directly
// against a mocked `fetch`, no React) plus a thin hook wrapper
// (hooks/useExerciseControl.ts) — same split, same reason: this project's
// vitest runs with no jsdom (vitest.config.ts), so a mounted component's
// effects never fire under `renderToStaticMarkup`.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the UI never
// states the simulator's state from anything the simulator or the adapter
// says. `status.activity` (running/paused/unknown) comes ONLY from
// GET /exercise/status's own `activity` field, which the service derives
// from PDU rate — never from `last_command`. This controller carries both
// fields through untouched and never cross-reads one into the other.
const EXERCISE_STATUS_URL = '/exercise/status';
const RESET_PREFLIGHT_URL = '/exercise/reset/preflight';

/** GET /exercise/reset/preflight: open Restate invocations per runtime. */
export interface ResetPreflightRuntime {
  name: string;
  open: number | null;
  error: string | null;
}

export interface ResetPreflight {
  limit: number;
  runtimes: ResetPreflightRuntime[];
  over: string[];
  open_over: number;
  needs_confirmation: boolean;
  unreadable: boolean;
}

/** What the confirm step knows about the open work. `unavailable` covers a
 *  403/5xx/transport fault and a count that could not be read on every
 *  runtime: the reset may then stop at its own pre-flight. */
export type ResetPreflightView =
  | { kind: 'loading' }
  | { kind: 'ready'; preflight: ResetPreflight }
  | { kind: 'unavailable' };

export interface ResetConfirmBody {
  confirm_cancel_open: true;
  seen_open: number;
}

/** The body the reset POST carries: ONLY when the operator was shown a count
 *  over the limit. Every other state sends a plain reset (no body). */
export function resetConfirmBody(view: ResetPreflightView | null): ResetConfirmBody | undefined {
  if (!view || view.kind !== 'ready') return undefined;
  const pf = view.preflight;
  if (pf.unreadable || !pf.needs_confirmation) return undefined;
  return { confirm_cancel_open: true, seen_open: pf.open_over };
}

export type ExerciseActivityState = 'running' | 'paused' | 'unknown';

export interface ExerciseSourceStatus {
  url: string;
  reachable: boolean;
  rate: number | null;
}

export interface ExerciseActivity {
  state: ExerciseActivityState;
  label: string;
  window_s: number;
  min_rate: number;
  sources: ExerciseSourceStatus[];
}

export interface ExerciseLastCommand {
  op: string;
  at: string;
  status: number | null;
  error: string | null;
  subject: string;
  /** One entry per adapter call the op made (halts at the first failure). */
  steps?: { method: string; path: string; status: number | null; error: string | null }[];
  /** Set when the op was sent on behalf of another (the reset's pause). */
  via?: string;
  job?: string;
  /** True when the op started a named sequence. */
  sequence?: boolean;
}

/** A named, supervisor-only timed list of calls the server declares. */
export interface ExerciseSequence {
  name: string;
  label: string;
  description?: string;
  steps: number;
  total_wait_s: number;
  /** False when the gateway would refuse this subject. Absent means allowed. */
  may_press?: boolean;
}

export interface ExerciseSequenceStep {
  i: number;
  kind: 'call' | 'wait';
  name?: string | null;
  method?: string;
  url?: string;
  wait_s?: number;
  state: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  status: number | null;
  error: string | null;
  at: string | null;
  done_at: string | null;
}

export interface ExerciseSequenceRun {
  op: string;
  label: string;
  subject: string;
  started_at: string;
  finished_at: string | null;
  state: 'running' | 'completed' | 'halted';
  steps: ExerciseSequenceStep[];
}

export interface ExerciseAdapter {
  name: string;
  ops: string[];
}

export interface ExerciseReset {
  measured_zero_at: string | null;
  verdict: string | null;
}

export interface ExerciseResetJobLatest {
  name: string;
  state: 'running' | 'succeeded' | 'failed';
  started_at: string | null;
  finished_at: string | null;
  requested_by: string | null;
}

/** The in-cluster reset Job behind the "Restart exercise" action. */
export interface ExerciseResetJob {
  available: boolean;
  latest: ExerciseResetJobLatest | null;
  error: string | null;
  /** False when the gateway would refuse this subject's reset. Absent from
   *  gateways that predate the field, which is treated as allowed. */
  may_press?: boolean;
  /** What the button runs: the quick clear (the exercise stays paused) or the
   *  full measured reset plus restart. Absent from controls that predate the
   *  field, which is treated as full. */
  mode?: 'quick' | 'full';
}

export interface ExerciseStatusBody {
  adapter: ExerciseAdapter;
  last_command: ExerciseLastCommand | null;
  activity: ExerciseActivity;
  reset: ExerciseReset;
  /** Absent from servers that predate the reset Job. */
  reset_job?: ExerciseResetJob;
  /** Absent from servers that predate named sequences. */
  sequences?: ExerciseSequence[];
  /** The latest sequence run, running or finished; null when none yet. */
  sequence?: ExerciseSequenceRun | null;
}

export interface ExerciseControlState {
  /** 'absent' = not wired at this tier (404 from the gateway): render
   *  nothing, same meaning as linkControl's equivalent cases.
   *  'forbidden' = 401/403: this subject does not hold the exercise-control
   *  role.
   *  'loading' = no successful poll yet (and not forbidden/absent).
   *  'ok' = a status body has been read at least once. */
  kind: 'absent' | 'forbidden' | 'ok' | 'loading';
  status: ExerciseStatusBody | null;
  /** The most recent poll failed at the network level (not 401/403/404):
   *  the UI keeps the last good status rather than blanking it. Never
   *  guessed into absent/forbidden — those are answers, this is silence. */
  stale: boolean;
  /** Why the last op was refused (e.g. 'reset_running'), or absent. A refusal
   *  sent nothing, so it is kept apart from last_command. Cleared by the
   *  next op that is accepted. */
  refusal?: string;
}

export interface ExerciseControlController {
  getState(): ExerciseControlState;
  /** One GET /exercise/status. Call on mount and on every poll tick. */
  poll(): Promise<void>;
  /** POST /exercise/op/<op>. The gateway's own response IS the new
   *  last_command — folded into state immediately so the popup need not
   *  wait for the next poll to show what was just sent. */
  runOp(op: string, body?: ResetConfirmBody): Promise<void>;
  /** One GET /exercise/reset/preflight, folded into a view; never throws. */
  resetPreflight(): Promise<ResetPreflightView>;
  subscribe(fn: () => void): () => void;
}

export function createExerciseControlController(
  fetchImpl: typeof fetch = fetch,
): ExerciseControlController {
  let state: ExerciseControlState = { kind: 'loading', status: null, stale: false };
  const listeners = new Set<() => void>();

  function setState(next: ExerciseControlState): void {
    // Omitted rather than null when there is no refusal, so the state keeps
    // its pre-existing shape.
    state = next.refusal ? next : { kind: next.kind, status: next.status, stale: next.stale };
    for (const l of Array.from(listeners)) l();
  }

  async function poll(): Promise<void> {
    try {
      const res = await fetchImpl(EXERCISE_STATUS_URL, { credentials: 'same-origin' });
      if (res.status === 404) {
        setState({ kind: 'absent', status: null, stale: false });
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setState({ kind: 'forbidden', status: null, stale: false });
        return;
      }
      if (!res.ok) throw new Error(`GET ${EXERCISE_STATUS_URL} -> ${res.status}`);
      const body = (await res.json()) as ExerciseStatusBody;
      setState({ kind: 'ok', status: body, stale: false, refusal: state.refusal });
    } catch (err) {
      console.error('exercise control status error', err);
      // A transport failure talking to the GATEWAY — keep whatever is
      // already known and mark it stale, never guess absent/forbidden/ok.
      setState({ ...state, stale: true });
    }
  }

  async function resetPreflight(): Promise<ResetPreflightView> {
    try {
      const res = await fetchImpl(RESET_PREFLIGHT_URL, { credentials: 'same-origin' });
      if (!res.ok) return { kind: 'unavailable' };
      const doc = (await res.json()) as ResetPreflight;
      if (!doc || !Array.isArray(doc.runtimes) || typeof doc.limit !== 'number') {
        return { kind: 'unavailable' };
      }
      if (doc.unreadable) return { kind: 'unavailable' };
      return { kind: 'ready', preflight: doc };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function runOp(op: string, confirmBody?: ResetConfirmBody): Promise<void> {
    try {
      const res = await fetchImpl(`/exercise/op/${encodeURIComponent(op)}`, {
        method: 'POST',
        credentials: 'same-origin',
        ...(confirmBody
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirmBody) }
          : {}),
      });
      const isSequence = (state.status?.sequences ?? []).some((q) => q.name === op);
      if ((op === 'reset' || isSequence) && res.status === 403) {
        // A refused reset or sequence is a refusal, not a loss of exercise-control access.
        const refused = (await res.json()) as { reason?: string; error?: string };
        setState({ ...state, refusal: refused.reason ?? refused.error ?? 'refused (403)' });
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setState({ kind: 'forbidden', status: state.status, stale: state.stale });
        return;
      }
      if (res.status === 404) {
        setState({ kind: 'absent', status: null, stale: false });
        return;
      }
      if (res.status === 409 || res.status === 502) {
        // Refused or not created: nothing was sent, so last_command stays.
        const refused = (await res.json()) as { reason?: string; error?: string };
        setState({ ...state, refusal: refused.reason ?? refused.error ?? `refused (${res.status})` });
        return;
      }
      if (res.status === 202 && isSequence) {
        // A sequence started: the body is the run record. Shown as served;
        // later progress arrives only through polling.
        const run = (await res.json()) as ExerciseSequenceRun;
        if (state.status) {
          const sent: ExerciseLastCommand = {
            op, at: run.started_at, status: 202, error: null, subject: run.subject, sequence: true,
          };
          setState({
            kind: 'ok', status: { ...state.status, sequence: run, last_command: sent }, stale: state.stale,
          });
        }
        return;
      }
      if (res.status === 202) {
        // reset: a Job was created. The body carries no status of its own;
        // 202 is the send outcome.
        const accepted = (await res.json()) as Omit<ExerciseLastCommand, 'status' | 'error'>;
        if (state.status) {
          const sent = { ...accepted, status: 202, error: null };
          setState({ kind: 'ok', status: { ...state.status, last_command: sent }, stale: state.stale });
        }
        return;
      }
      // The gateway forwarded this call -- its response body IS the new
      // last_command (op, at, status|error, subject), same shape
      // GET /exercise/status carries. Never read anything from this
      // response as the simulator's state; only last_command is taken.
      const body = (await res.json()) as ExerciseLastCommand;
      if (state.status) {
        setState({ kind: 'ok', status: { ...state.status, last_command: body }, stale: state.stale });
      }
    } catch (err) {
      console.error('exercise control op error', err);
      setState({ ...state, stale: true });
    }
  }

  return {
    getState() {
      return state;
    },
    poll,
    runOp,
    resetPreflight,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
