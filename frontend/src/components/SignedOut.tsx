// =============================================================================
// SignedOut — what the screen says when there is no session
// =============================================================================
// THE DEFECT THIS REPLACES. The gateway guards the DATA paths and left the
// static shell public, so an unauthenticated visitor got the whole
// application: header, tier badge, every panel — and every panel showed
// "Syncing…", because its shape request was coming back 401 and the panels
// only knew about `isLoading`.
//
// "Syncing…" for a 401 is ADR-0035 class 2: an absence rendered as
// something else. It says *data is on its way* when the truth is *you are
// not signed in*, and it says it on what is, in effect, the login screen.
// An operator waits for a sync that will never complete.
//
// It also leaked. Before any decision had been made about the viewer, the
// shell had already displayed the tier's id, its parent, the panel
// inventory, and the buffer state — topology and capability structure, to
// anyone who could reach the host. For a coalition system that is the wrong
// default, so the gateway now gates `/` as well and this screen is the
// belt-and-braces for the session that expires while a tab is open.
//
// WHY THIS IS A WHOLE-SCREEN STATE AND NOT A PER-PANEL ONE. Threading "not
// signed in" through fourteen panels would have fourteen places to get it
// wrong and would still render the header, the tier badge and the panel
// inventory around the message. Not-signed-in is a fact about the SESSION,
// so it is stated once, at the root, and nothing else renders.
import { deployment } from '../deployment';
import { loginHref } from '../lib/loginHref';
import type { SessionError as SessionErrorInfo } from '../hooks/useSession';

export function SignedOut() {
  // The overlay's logo when a deployment sets one; the OpenDDIL mark
  // otherwise. `public/brand/logo.png` is served by the frontend's own
  // nginx and is deliberately NOT behind the session gate — a login screen
  // that cannot load its own image is a worse failure than a public logo.
  const logo = deployment().logo || '/brand/logo.png';

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-300 font-mono
                    flex flex-col items-center justify-center gap-6 px-6">
      <img
        src={logo}
        alt="OpenDDIL"
        className="h-40 w-auto object-contain rounded-sm opacity-95"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />

      <div className="text-center">
        {/* STATE THE STATE. Not "Syncing", not "Loading", not a spinner:
            the session is absent and that is a finished answer, not a
            pending one. */}
        <div className="font-orbitron tracking-widest text-cyan-400 text-lg">
          NOT SIGNED IN
        </div>
        <p className="mt-3 max-w-md text-xs leading-relaxed text-slate-500">
          This deployment requires a session before it will show anything.
          No fleet data, and no information about this node, is served to an
          unauthenticated browser.
        </p>
      </div>

      <a
        href={loginHref()}
        className="rounded-sm border border-cyan-700/60 bg-cyan-500/10 px-6 py-2
                   text-xs font-bold tracking-widest text-cyan-300
                   hover:bg-cyan-500/20 transition-colors"
      >
        SIGN IN
      </a>
    </div>
  );
}

// =============================================================================
// CheckingSession — the UNKNOWN state, which is not the same as signed out
// =============================================================================
// `useSession` returns `authenticated: undefined` while /auth/me is in
// flight, and the distinction is load-bearing: rendering SignedOut during
// that window flashes a login prompt on every page load for every user who
// is perfectly well logged in. Rendering the APP during that window is the
// other error, and the one that produced "Syncing…" on a 401.
//
// So: neither. A third state, which is what "we do not know yet" honestly
// looks like.
export function CheckingSession() {
  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-600 font-mono
                    flex items-center justify-center text-xs tracking-widest">
      <span className="animate-pulse">CHECKING SESSION…</span>
    </div>
  );
}

// =============================================================================
// SessionError — /auth/me never answered, so the session is still unknown
// =============================================================================
// The initial check retried and every attempt failed. Saying "checking" any
// longer would be the same absence-as-something-else as "Syncing…" on a 401,
// so this names the request that failed and offers the two things an
// operator can do about it. The hook keeps re-checking underneath, so this
// screen clears itself if the gateway comes back.
export function SessionError({ error }: { error: SessionErrorInfo }) {
  const outcome = error.status === null ? 'network error' : String(error.status);
  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-300 font-mono
                    flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="font-orbitron tracking-widest text-cyan-400 text-lg">
        Could not confirm your session
      </div>
      <div className="text-xs text-slate-400">
        <div>{error.method} {error.path} → {outcome}</div>
        <div className="mt-1 text-slate-500">after {error.attempts} attempts</div>
        <div className="mt-1 max-w-md break-words text-slate-500">{error.detail}</div>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-sm border border-cyan-700/60 bg-cyan-500/10 px-6 py-2
                     text-xs font-bold tracking-widest text-cyan-300
                     hover:bg-cyan-500/20 transition-colors"
        >
          Retry
        </button>
        <a href={loginHref()} className="text-xs text-cyan-400 underline">
          Sign in again
        </a>
      </div>
    </div>
  );
}

export default SignedOut;
