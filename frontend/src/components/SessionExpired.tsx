// =============================================================================
// SessionExpired — expiry is not link loss
// =============================================================================
// THE DEFECT THIS REPLACES. On expiry the screen used to be a thin
// "last copy" banner at the top, while every fleet value stayed on screen
// underneath it. That is correct
// for LINK LOSS (the viewer is still entitled, the network is not) and
// wrong for EXPIRY (the viewer is no longer entitled) — the data panels
// must come OUT of the DOM, not just get a warning stapled above them.
//
// So this is a whole-screen state, same reasoning as SignedOut: the gate in
// Root.tsx renders this INSTEAD of the app, and unmounting is the point —
// blurring, graying out, or overlaying the old screen does not satisfy it,
// because the fleet values would still be sitting in the DOM underneath.
//
// It shows no tier or topology details, the same rule SignedOut follows:
// before any decision has been re-made about the viewer, the screen does
// not leak what tier this is or what it holds.
import { deployment } from '../deployment';
import { loginHref } from '../lib/loginHref';

export function SessionExpired() {
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
        <div className="font-orbitron tracking-widest text-amber-400 text-lg">
          SESSION EXPIRED
        </div>
        <p className="mt-3 max-w-md text-xs leading-relaxed text-slate-500">
          Your session has expired. Sign in again to continue — you will
          return to the same view.
        </p>
      </div>

      {/* prompt=login: the PEP session ending does not end the identity
          provider's session; without it, sign-in returns through that live
          session with no password asked. */}
      <a
        href={loginHref({ forceLogin: true })}
        className="rounded-sm border border-cyan-700/60 bg-cyan-500/10 px-6 py-2
                   text-xs font-bold tracking-widest text-cyan-300
                   hover:bg-cyan-500/20 transition-colors"
      >
        SIGN IN
      </a>
    </div>
  );
}

export default SessionExpired;
