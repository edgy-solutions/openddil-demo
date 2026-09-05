// =============================================================================
// IdentityBadge — whose screen is this?
// =============================================================================
// THE AUDIENCE MUST ALWAYS KNOW WHOSE SCREEN THEY ARE LOOKING AT.
//
// That is true in a demo, where two windows sit side by side and the whole
// point is that they differ. It is more true in operation: a coalition
// operator who cannot tell at a glance which entitlements are producing the
// picture in front of them has no way to notice when the picture is smaller
// than they expected — and "smaller than expected" is exactly what correct
// enforcement and a broken feed look like.
//
// THE NATIONS SHOWN HERE COME FROM TOPAZ, not from a token claim. The badge
// and the filter are the same answer from the same authority. A badge fed
// from an identity-provider claim could disagree with the rows below it, and
// the rows would be the ones telling the truth.
import { ShieldCheck, LogIn, LogOut } from 'lucide-react';
import { useSession } from '../../hooks/useSession';
import { nationStyle } from '../../lib/nationColor';

export default function IdentityBadge() {
  const s = useSession();

  // Unknown is NOT "logged out". Rendering a sign-in prompt during the first
  // request makes every page flash it on load, and a flashing sign-in button
  // trains people to click it.
  if (s.authenticated === undefined) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <ShieldCheck size={14} className="opacity-40" />
        <span>checking session…</span>
      </div>
    );
  }

  // Authentication is not deployed here. Say so rather than offering a
  // sign-in button that 404s — and say it in a way that does not read as
  // "you are secure", because this deployment is not enforcing identity.
  if (s.authDisabled) {
    return (
      <div className="flex items-center gap-2 rounded border border-amber-500/40
                      bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
        <ShieldCheck size={14} />
        <span>no identity enforcement on this deployment</span>
      </div>
    );
  }

  if (!s.authenticated) {
    return (
      <a href="/auth/login"
         className="flex items-center gap-2 rounded border border-sky-500/40
                    bg-sky-500/10 px-2 py-1 text-xs text-sky-300
                    hover:bg-sky-500/20">
        <LogIn size={14} />
        <span>Sign in</span>
      </a>
    );
  }

  const who = s.name || s.username || s.subject || 'unknown';

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 rounded border border-slate-600/60
                      bg-slate-800/60 px-2 py-1">
        <ShieldCheck size={14} className="text-emerald-400" />
        <span className="text-xs text-slate-300">
          Viewing as <span className="font-semibold text-slate-100">{who}</span>
        </span>

        {/* The entitlements, spelled out. An operator holding two nations
            and an operator holding one look identical without this, and the
            difference is the whole mechanism. */}
        <span className="flex items-center gap-1">
          {s.nations.length === 0 ? (
            // ENTITLED TO NOTHING IS A REAL STATE and is not the same as an
            // error. It renders an empty fleet, correctly, and the operator
            // needs to be able to tell that from a broken feed.
            <span className="rounded border border-dashed border-slate-500/50
                             px-1 text-[10px] uppercase text-slate-400">
              no nations
            </span>
          ) : (
            s.nations.map((code) => {
              const n = nationStyle(code);
              return (
                <span key={code}
                      title={n.label}
                      className={`rounded border px-1 text-[10px] font-semibold
                                  uppercase ${n.chip}`}>
                  {n.code}
                </span>
              );
            })
          )}
        </span>
      </div>

      {/* THE SECOND AXIS, shown beside the first because they are different
          questions and an operator needs both. Nations answer "whose data am
          I seeing"; role answers "what am I able to do here". The tab
          switcher conflated them, which is why a fourth tier had no answer.

          Displayed, and NOT used to filter anything — see useSession. */}
      <span className="hidden rounded border border-slate-600/60 px-1.5 py-0.5
                       text-[10px] uppercase tracking-wide text-slate-400 md:inline"
            title="Role within this tier — selects affordances, never data">
        {s.role}
      </span>

      {/* The policy version that produced those nations — the same string the
          decision log records, so a screenshot and an audit line can be tied
          together after the fact without guessing at timestamps. */}
      {s.policyVersion && (
        <span className="hidden text-[10px] text-slate-500 lg:inline"
              title="policy version that produced these entitlements">
          {s.policyVersion}
        </span>
      )}

      <a href="/auth/logout"
         title="Sign out"
         className="rounded border border-slate-600/60 p-1 text-slate-400
                    hover:text-slate-200">
        <LogOut size={14} />
      </a>
    </div>
  );
}
