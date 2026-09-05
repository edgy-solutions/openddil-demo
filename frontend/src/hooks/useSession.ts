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
import { useEffect, useState } from 'react';

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
};

export function useSession(): Session {
  const [session, setSession] = useState<Session>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    // `credentials: 'same-origin'` is the default for same-origin requests
    // and stated here anyway: the whole point of this endpoint is the
    // cookie, and a future move to a different origin would silently stop
    // sending it.
    fetch('/auth/me', { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          // The gateway serves no auth routes — header mode, or no PEP.
          setSession({ ...UNKNOWN, authenticated: false, authDisabled: true });
          return;
        }
        if (res.status === 401) {
          setSession({ ...UNKNOWN, authenticated: false });
          return;
        }
        const body = await res.json();
        setSession({
          authenticated: Boolean(body.authenticated),
          subject: body.subject ?? null,
          username: body.username ?? '',
          name: body.name ?? '',
          nations: Array.isArray(body.nations) ? body.nations : [],
          role: typeof body.role === 'string' && body.role ? body.role : 'observer',
          policyVersion: body.policy_version ?? null,
          authDisabled: false,
        });
      })
      .catch(() => {
        // A failed /auth/me is NOT a reason to claim the user is logged out
        // — that would render a sign-in prompt over a working screen every
        // time the network hiccuped. Stay in the unknown state; the data
        // below is filtered by the gateway either way.
        if (!cancelled) setSession(UNKNOWN);
      });
    return () => { cancelled = true; };
  }, []);

  return session;
}
