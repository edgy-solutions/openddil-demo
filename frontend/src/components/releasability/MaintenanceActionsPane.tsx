// =============================================================================
// MaintenanceActionsPane — the mirror of EgressAdmissionPane, destination
// fixed to the maintenance bridge (ADR-0046 s5)
// =============================================================================
// Same mechanism, different destination (ADR-0046's own "Neutral"
// consequence: "The C2 pane and the maintenance pane are the same mechanism
// with different destinations. A third destination is configuration, not
// code."). `useEgressAdmission` is the SAME hook EgressAdmissionPane uses —
// it already takes a destination parameter, so nothing about the hook
// changed for this pane to exist. What differs is the record shape: a
// maintenance action carries work-order fields beside the same
// asset_id/originator_nation/releasable_to/allowed/reason/decision_id
// every egress decision carries (see useEgressAdmission.ts's DecisionRecord),
// so this file renders those fields instead of originator/releasable_to —
// it does not re-decide anything, exactly as EgressAdmissionPane does not.
//
// Unlike EgressAdmissionPane, the destination here is NOT an operator-edited
// field: this is the maintenance pane, not a generic destination explorer,
// so it always reads `system:mmis-stand-in`.
//
// `MaintenanceActionsView` is exported separately from the default for the
// same reason `DecisionsView` is: a test can render it off an endpoint-shaped
// fixture without exercising the fetch hook (react-dom/server's
// renderToStaticMarkup — no @testing-library/react, no jsdom, see
// vitest.config.ts).
import {
  useEgressAdmission,
  type DecisionRecord,
  type DecisionsResponse,
} from '../../hooks/useEgressAdmission';

const DESTINATION = 'system:mmis-stand-in';

function tallyRefusals(records: DecisionRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.allowed) continue;
    const reason = r.reason ?? 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatParts(record: DecisionRecord): string {
  const parts = record.work_order?.parts ?? [];
  if (parts.length === 0) return '—';
  return parts.map((p) => `${p.item} x${p.quantity} (${p.source_site})`).join(', ');
}

function formatApprovalChain(record: DecisionRecord): string {
  const chain = record.approval_chain ?? [];
  if (chain.length === 0) return '—';
  return chain.map((s) => `${s.role}: ${s.approver_sub} (${s.decision})`).join(' → ');
}

function formatTaskRefs(record: DecisionRecord): string {
  const refs = record.work_order?.task_refs ?? [];
  if (refs.length === 0) return '—';
  return refs.map((r) => r.dmc ?? r.uri).join(', ');
}

export function MaintenanceActionsView({ data }: { data: DecisionsResponse }) {
  const total = data.records.length;
  const tally = tallyRefusals(data.records);
  // Present only when the PEP filtered this response — see
  // useEgressAdmission.ts's `DecisionsResponse.withheld`. Compose's direct,
  // unfiltered pane sends neither field, and the pane withholds nothing.
  const hasWithheld = typeof data.withheld === 'number' && data.withheld > 0;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-sm text-slate-200">
          <span className="font-mono text-lg text-emerald-300">{data.admitted}</span>
          <span className="text-slate-500"> of </span>
          <span className="font-mono text-lg text-slate-200">{total}</span>
          <span className="text-slate-500"> admitted</span>
        </div>
        <div className="text-[10px] text-slate-500">
          policy {data.policy_version} · corpus {data.corpus_version}
        </div>
      </div>

      {/* Same rule as EgressAdmissionPane's withheld line: `withheld` counts
          only UNLABELLED records, never "hidden from this viewer" — see
          gateway/egress_view.py. */}
      {hasWithheld && (
        <div className="mb-1 text-[11px] text-slate-400">
          <span className="font-mono text-amber-300">{data.withheld}</span> withheld —
          unlabelled, so shown to no one, including fully entitled viewers
          {data.viewer_nations ? ` · viewing as ${data.viewer_nations.join(', ')}` : ''}
        </div>
      )}

      {tally.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {tally.map(([reason, count]) => (
            <span key={reason}>
              <span className="font-mono text-rose-300">{count}</span> {reason}
            </span>
          ))}
        </div>
      )}

      {total === 0 ? (
        <div className="text-xs text-slate-500">
          No records for this destination are visible to you.
        </div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-slate-500">
              <th className="pb-1 text-left">action</th>
              <th className="pb-1 text-left">asset</th>
              <th className="pb-1 text-left">task</th>
              <th className="pb-1 text-left">parts</th>
              <th className="pb-1 text-left">approval chain</th>
              <th className="pb-1 text-left">outcome</th>
              <th className="pb-1 text-left">decided at</th>
              <th className="pb-1 text-left">task refs</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.action_id ?? r.decision_id} className="border-t border-slate-800">
                <td className="py-1 text-slate-300">{r.action_id ?? '—'}</td>
                <td className="py-1 text-slate-400">{r.asset_id}</td>
                <td className="py-1 text-slate-400">{r.work_order?.task ?? '—'}</td>
                <td className="py-1 text-slate-400">{formatParts(r)}</td>
                <td className="py-1 text-slate-400">{formatApprovalChain(r)}</td>
                {/* Verbatim from the endpoint, same as EgressAdmissionPane:
                    no nation is read here to pick this cell's text or color. */}
                <td className={r.allowed ? 'py-1 text-emerald-300' : 'py-1 text-rose-300'}>
                  {r.allowed ? 'ADMIT' : r.reason}
                </td>
                <td className="py-1 text-slate-500">{r.decided_at ?? '—'}</td>
                <td className="py-1 text-slate-500">{formatTaskRefs(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function MaintenanceActionsPane() {
  const { data, isLoading, isError, isPolicyUnavailable, policyUnavailableDetail } =
    useEgressAdmission(DESTINATION);

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-slate-200">
          Maintenance actions released to the maintenance system (stand-in)
        </h3>
      </div>

      {isPolicyUnavailable ? (
        <div className="text-xs text-amber-300">
          Policy unavailable — the PDP could not be reached
          {policyUnavailableDetail ? `: ${policyUnavailableDetail}` : '.'} This is an outage,
          not a decision that nothing is admitted.
        </div>
      ) : isError ? (
        <div className="text-xs text-rose-400">Could not load maintenance actions.</div>
      ) : isLoading && !data ? (
        <div className="text-xs text-slate-500">Loading maintenance actions…</div>
      ) : data ? (
        <MaintenanceActionsView data={data} />
      ) : (
        <div className="text-xs text-slate-500">No data.</div>
      )}
    </div>
  );
}
