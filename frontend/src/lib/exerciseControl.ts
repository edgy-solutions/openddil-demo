// =============================================================================
// exerciseControl — the exercise-control popup's commanded/observed state
// =============================================================================
// Pattern: lib/wanLink.ts. A framework-free controller (tested directly
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
}

export interface ExerciseAdapter {
  name: string;
  ops: string[];
}

export interface ExerciseReset {
  measured_zero_at: string | null;
  verdict: string | null;
}

export interface ExerciseStatusBody {
  adapter: ExerciseAdapter;
  last_command: ExerciseLastCommand | null;
  activity: ExerciseActivity;
  reset: ExerciseReset;
}

export interface ExerciseControlState {
  /** 'absent' = not wired at this tier (404 from the gateway): render
   *  nothing, same meaning as wanLink's equivalent cases.
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
}

export interface ExerciseControlController {
  getState(): ExerciseControlState;
  /** One GET /exercise/status. Call on mount and on every poll tick. */
  poll(): Promise<void>;
  /** POST /exercise/op/<op>. The gateway's own response IS the new
   *  last_command — folded into state immediately so the popup need not
   *  wait for the next poll to show what was just sent. */
  runOp(op: string): Promise<void>;
  subscribe(fn: () => void): () => void;
}

export function createExerciseControlController(
  fetchImpl: typeof fetch = fetch,
): ExerciseControlController {
  let state: ExerciseControlState = { kind: 'loading', status: null, stale: false };
  const listeners = new Set<() => void>();

  function setState(next: ExerciseControlState): void {
    state = next;
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
      setState({ kind: 'ok', status: body, stale: false });
    } catch (err) {
      console.error('exercise control status error', err);
      // A transport failure talking to the GATEWAY — keep whatever is
      // already known and mark it stale, never guess absent/forbidden/ok.
      setState({ ...state, stale: true });
    }
  }

  async function runOp(op: string): Promise<void> {
    try {
      const res = await fetchImpl(`/exercise/op/${encodeURIComponent(op)}`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.status === 401 || res.status === 403) {
        setState({ kind: 'forbidden', status: state.status, stale: state.stale });
        return;
      }
      if (res.status === 404) {
        setState({ kind: 'absent', status: null, stale: false });
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
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
