// =============================================================================
// useSession — who is looking at this screen, and what are they entitled to
// =============================================================================
// Reads the gateway's /auth/me. Two things about where the answer comes from
// are deliberate and worth stating, because both are easy to "improve" into
// something wrong:
//
// 1. THE NATIONS COME FROM TOPAZ, NOT FROM A TOKEN CLAIM. The gateway asks
//    the policy decision point and returns what it was told, so the badge on
//    screen and the filter on the data are THE SAME ANSWER FROM THE SAME
//    AUTHORITY. A badge fed from an identity-provider claim could disagree
//    with the rows below it, and the rows would be the ones telling the
//    truth — an operator would have no way to know which to believe.
//
// 2. THIS IS PRESENTATION, NOT ACCESS CONTROL. Nothing here filters
//    anything. ADR-0029 §1: frontend role views are not access control, they
//    consume an already-filtered stream, and any filtering they do for
//    presentation must be understood as cosmetic. If this hook returned no
//    nations the screen would still show exactly the rows the gateway
//    allowed — which is the correct behaviour and the reason it is safe for
//    this call to fail.
//
// The browser never sees a token. It holds an httpOnly session cookie it
// cannot read, and this endpoint is how the page learns anything about its
// own session at all.
//
// EXPIRY IS NOT LINK LOSS. This hook distinguishes two different 401s and
// one timer:
//   - the FIRST /auth/me answering 401 just means "not logged in" — there
//     was never a session to lose;
//   - a RE-CHECK answering 401 means a session that WAS good just ended,
//     which is expiry, and marks it so via lib/sessionExpiry;
//   - a failed FETCH (network error, timeout, 5xx) is neither of those —
//     it is link loss, and must never be read as "signed out" or "expired".
import { useEffect, useRef, useState } from 'react';
import { setLabeledTables } from '../lib/labeledTables';
import { markSessionExpired } from '../lib/sessionExpiry';

export interface Session {
  /** Undefined while the first request is in flight — distinct from `false`,
   *  which is a definite "not logged in". Rendering a login prompt during
   *  the unknown state makes every page flash it on load. */
  authenticated: boolean | undefined;
  subject: string | null;
  username: string;
  name: string;
  /** Nations this subject may see, as decided by Topaz. */
  nations: string[];
  /** The subject's role within this tier — the SECOND axis.
   *
   *  WHICH TIER is a fact about where you logged in; WHICH ROLE is a fact
   *  about you. Keeping them apart is the whole reason the tab switcher had
   *  to go: "maintainer / regional / hq / controller" mixed a role with two
   *  tier depths and a tool, which is why a fourth tier had no answer.
   *
   *  ⚠ AFFORDANCES, NOT ROWS. Role selects which panels and controls a
   *  subject is offered. It must never filter data — `nations` is the whole
   *  of the read-path decision, applied by the gateway before anything
   *  reaches here. A role-based filter in the browser would be a second
   *  authorization decision nobody reviewed (ADR-0029 §1).
   *
   *  Defaults to the least-privileged value, so a subject whose corpus row
   *  omits a role gets read-only affordances rather than a blank screen. */
  role: string;
  /** The policy version that produced those nations — the same string the
   *  decision log records, so a screenshot and an audit line can be tied
   *  together after the fact. */
  policyVersion: string | null;
  /** The deployment does not have authentication enabled. NOT the same as
   *  "not logged in": there is nothing to log in to, and the header should
   *  say so rather than offering a sign-in button that 404s. */
  authDisabled: boolean;
  /** Local (browser-clock) epoch-ms deadline for this session, or null
   *  while unknown or unauthenticated. Computed as
   *  `Date.now() + (expires_at - server_time) * 1000` so a skewed browser
   *  clock shifts the computed deadline by exactly the skew and no more —
   *  the gap between the two server-reported numbers is clock-agnostic. */
  expiresAt: number | null;
}

const UNKNOWN: Session = {
  authenticated: undefined,
  subject: null,
  username: '',
  name: '',
  nations: [],
  role: 'observer',
  policyVersion: null,
  authDisabled: false,
  expiresAt: null,
};

// Re-check while authenticated, both to catch expiry between user-initiated
// requests and to keep traffic flowing during idle periods — the PEP's own
// lead-time refresh (REFRESH_LEAD_S) only has a chance to run on a request
// that actually arrives before the deadline.
const RECHECK_MS = 60_000;

export function useSession(): Session {
  const [session, setSession] = useState<Session>(UNKNOWN);
  const sessionRef = useRef<Session>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let deadlineId: ReturnType<typeof setTimeout> | undefined;

    function stopPolling() {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    }

    function armDeadline(expiresAt: number | null) {
      if (deadlineId !== undefined) {
        clearTimeout(deadlineId);
        deadlineId = undefined;
      }
      if (expiresAt == null) return;
      // The deadline passing, on the BROWSER's
      // own clock, fires the same signal a 401 would. A delay that is
      // already <= 0 (clock moved backward between the answer and now, or
      // the answer was stale in flight) fires on the next tick rather than
      // never firing at all.
      const delay = Math.max(expiresAt - Date.now(), 0);
      deadlineId = setTimeout(() => { markSessionExpired(); }, delay);
    }

    function commit(next: Session) {
      sessionRef.current = next;
      if (!cancelled) setSession(next);
    }

    function checkOnce(isInitial: boolean) {
      fetch('/auth/me', { credentials: 'same-origin' })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 404) {
            // The gateway serves no auth routes — header mode, or no PEP.
            // Nothing to poll for: there is no session that can expire.
            armDeadline(null);
            stopPolling();
            commit({ ...UNKNOWN, authenticated: false, authDisabled: true });
            return;
          }
          if (res.status === 401) {
            // A RE-check 401 means a session that WAS good just ended.
            // The initial 401 means there was never one to lose.
            if (!isInitial) markSessionExpired();
            armDeadline(null);
            stopPolling();
            commit({ ...UNKNOWN, authenticated: false });
            return;
          }
          // Any other non-2xx (a 503 while the policy service is down, a
          // 5xx from a proxy) is the gateway failing, not the session
          // ending. Its body may still be JSON, without `authenticated`;
          // read as a session it would sign a live viewer out, so it takes
          // the failed-fetch path below instead.
          if (!res.ok) throw new Error(`/auth/me ${res.status}`);
          const body = await res.json();
          // The gateway's own list of partitionable tables, cached so the
          // shared shape client can explain a refusal with the same fact
          // the gateway refused on.
          setLabeledTables(body.labeled_tables);
          const expiresAt = (
            typeof body.expires_at === 'number' && typeof body.server_time === 'number'
          ) ? Date.now() + (body.expires_at - body.server_time) * 1000 : null;
          commit({
            authenticated: Boolean(body.authenticated),
            subject: body.subject ?? null,
            username: body.username ?? '',
            name: body.name ?? '',
            nations: Array.isArray(body.nations) ? body.nations : [],
            role: typeof body.role === 'string' && body.role ? body.role : 'observer',
            policyVersion: body.policy_version ?? null,
            authDisabled: false,
            expiresAt,
          });
          armDeadline(expiresAt);
        })
        .catch(() => {
          // A failed /auth/me — on the FIRST check or a re-check — is NOT a
          // reason to claim the user is logged out or expired: that would
          // render a sign-in prompt, or unmount the screen, over a working
          // session every time the network hiccuped. On a re-check, leave
          // the current session and its already-armed deadline exactly as
          // they are. On the first check only, fall back to the unknown
          // state so the page doesn't hang there forever.
          if (isInitial && !cancelled) commit(UNKNOWN);
        });
    }

    checkOnce(true);
    intervalId = setInterval(() => {
      if (cancelled) return;
      const current = sessionRef.current;
      if (current.authenticated && !current.authDisabled) checkOnce(false);
    }, RECHECK_MS);

    return () => {
      cancelled = true;
      stopPolling();
      if (deadlineId !== undefined) clearTimeout(deadlineId);
    };
  }, []);

  return session;
}
