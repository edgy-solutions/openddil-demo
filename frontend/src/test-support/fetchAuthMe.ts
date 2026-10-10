// =============================================================================
// fetchAuthMe — a controllable stand-in for the gateway's /auth/me
// =============================================================================
// There are three independent useSession() instances in the Root ->
// DemoShell -> MaintainerApp render path (Root.tsx itself, Header.tsx, and
// IdentityBadge.tsx), each firing its own fetch('/auth/me', ...) on mount
// and again every RECHECK_MS. All three must see the SAME answer, so this
// is one shared mutable fixture rather than a per-test inline mock.
//
// Not a vi.mock() registration — it's a plain `fetch` assignment — so,
// unlike the vi.mock(...) calls in mockElectric's consumers, centralizing
// this here carries none of the ESM-hoisting-order risk. See
// test-support/mockElectric.ts for why THOSE stay inlined per test file.
export type AuthMeMode = 'ok' | 'unauthorized' | 'network-error' | 'pdp-unavailable';

interface AuthMeState {
  mode: AuthMeMode;
  /** Absolute epoch seconds — mirrors hard_expires, which is a fixed
   *  ceiling. Computed once from "now + delta" at configuration time, NOT
   *  re-derived as "now + delta" on every call: a real session's
   *  hard_expires never moves, so the (expires_at - server_time) gap this
   *  reports must shrink as server_time advances, the same as the real
   *  gateway's. Re-deriving it fresh each call would silently re-arm the
   *  browser's deadline timer on every 60s re-check and the deadline test
   *  would never see the sentinel disappear. */
  deadlineEpochSeconds: number;
}

export interface AuthMeFetchControl {
  setMode(mode: AuthMeMode): void;
  /** Moves the fixed deadline to now + seconds. */
  setDelta(seconds: number): void;
}

/** Installs `globalThis.fetch`. Every test that uses this must mount
 *  through the real Root (whose useSession() calls are the only fetch
 *  callers in the mounted tree — useLinkControl's internal fetch is mocked
 *  away separately) so there is nothing else for this to need to answer. */
export function installAuthMeFetch(initial: { mode?: AuthMeMode; deltaSeconds?: number } = {}): AuthMeFetchControl {
  const state: AuthMeState = {
    mode: initial.mode ?? 'ok',
    deadlineEpochSeconds: Date.now() / 1000 + (initial.deltaSeconds ?? 3600),
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    if (url !== '/auth/me') {
      return Promise.reject(new Error(`fetchAuthMe stub: unexpected fetch target "${url}"`));
    }
    if (state.mode === 'network-error') {
      return Promise.reject(new Error('simulated network error'));
    }
    if (state.mode === 'unauthorized') {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    if (state.mode === 'pdp-unavailable') {
      // The gateway's own refusal shape when the policy decision point is
      // down: a 503 WITH a JSON body, which parses cleanly and carries no
      // `authenticated` field.
      return Promise.resolve(new Response(
        JSON.stringify({ error: 'denied', cause: 'PDP unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ));
    }
    const serverTime = Date.now() / 1000;
    const body = {
      authenticated: true,
      subject: 'sentinel-subject',
      username: 'sentinel',
      name: 'Sentinel Operator',
      nations: [],
      role: 'observer',
      policy_version: 'test-policy-1',
      labeled_tables: [],
      expires_at: state.deadlineEpochSeconds,
      server_time: serverTime,
    };
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }) as typeof fetch;

  return {
    setMode(mode: AuthMeMode) { state.mode = mode; },
    setDelta(seconds: number) { state.deadlineEpochSeconds = Date.now() / 1000 + seconds; },
  };
}
