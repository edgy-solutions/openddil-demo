// =============================================================================
// AccessDenied — an honest refusal
// =============================================================================
// WHAT THIS REPLACES: a raw 403 JSON body, or worse, an empty fleet.
//
// An empty fleet is the dangerous one. Correct enforcement and a broken feed
// produce the same screen, and an operator has no way to tell "you are not
// entitled to this" from "the pipeline stopped". ADR-0029 §7 makes that
// exact point about deny-unlabeled; it applies just as much to the person
// looking at the result.
//
// WHAT IT SHOWS, AND WHY EACH PART IS THERE
//
//   * A REFERENCE ID. The same string the gateway wrote to its decision log.
//     Without it, "why was I denied?" is answered by correlating timestamps,
//     which stops working the moment two people are refused in the same
//     second. It is safe to show because it identifies a decision RECORD and
//     carries nothing about the data.
//
//   * WHO the deployment thinks you are. A refusal that does not say which
//     identity was refused is unactionable — the commonest cause is being
//     signed in as the wrong account, and that is invisible otherwise.
//
//   * NO SUGGESTION OF WHAT EXISTS. It never says how many rows were
//     withheld, or which nations they belong to. A count of what you cannot
//     see is information about it.
//
// It does not offer a retry button. Retrying an authorization decision that
// was correctly taken produces the same answer, and a button that appears to
// promise otherwise wastes the operator's time at the moment they are
// already confused.
import { ShieldAlert } from 'lucide-react';

interface Props {
  /** The gateway's `reference` — the decision-log id. May be absent if the
   *  refusal came from somewhere that does not mint one; the panel then says
   *  so rather than showing a blank field that looks like a bug. */
  reference?: string | null;
  /** The gateway's `cause`. Shown because this UI is inside the trust
   *  boundary; a public-facing deployment renders the reference alone. */
  cause?: string | null;
  /** Who the deployment believes is asking. */
  subject?: string | null;
  username?: string | null;
}

export default function AccessDenied({ reference, cause, subject, username }: Props) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="max-w-lg rounded-lg border border-rose-500/40
                      bg-rose-950/20 p-6">
        <div className="mb-3 flex items-center gap-2 text-rose-300">
          <ShieldAlert size={20} />
          <h2 className="text-lg font-semibold">Not authorized</h2>
        </div>

        <p className="mb-4 text-sm text-slate-300">
          This account is not entitled to any of the data on this view. That is
          a policy decision, not a fault — the system is working, and it has
          declined.
        </p>

        <dl className="space-y-2 text-xs">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-slate-500">Signed in as</dt>
            <dd className="font-mono text-slate-300">
              {username || subject || <span className="text-slate-500">not signed in</span>}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-slate-500">Reference</dt>
            <dd className="font-mono text-slate-200">
              {reference || <span className="text-slate-500">none issued</span>}
            </dd>
          </div>
          {cause && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-slate-500">Cause</dt>
              <dd className="text-slate-400">{cause}</dd>
            </div>
          )}
        </dl>

        <p className="mt-5 border-t border-slate-700/60 pt-3 text-xs text-slate-500">
          Quote the reference to whoever administers entitlements. It
          identifies this exact decision in the gateway's audit log, including
          the policy version that produced it.
        </p>
      </div>
    </div>
  );
}
