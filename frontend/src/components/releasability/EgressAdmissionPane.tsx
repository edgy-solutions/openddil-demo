// =============================================================================
// EgressAdmissionPane — what crosses to a destination, and why the rest didn't
// =============================================================================
// The headline claim this pane makes ("N of M admitted") is only true
// because it renders `egress/pane_api.py`'s answer, and that endpoint calls
// the SAME `EgressGate.decide` path the running gate calls for the real wire
// (see its module docstring). Nothing below inspects `originator_nation` or
// `releasable_to` to decide anything — those two fields are shown for an
// operator's benefit, exactly the way `useFleetAssets.ts` already treats them
// as presentation-only. `allowed` and `reason` are rendered as given.
//
// `DecisionsView` is exported separately from the default so a test can
// render it straight off an endpoint-shaped fixture without also exercising
// the fetch hook (there is no @testing-library/react in this project's dev
// deps — see vitest.config.ts — so the test renders this component with
// react-dom/server's renderToStaticMarkup instead of mounting it in a DOM).
import { useState } from 'react';
import {
  useEgressAdmission,
  type DecisionRecord,
  type DecisionsResponse,
} from '../../hooks/useEgressAdmission';

// The only destination this corpus declares today (egress/main.py's own
// default). Not a menu of nations to pick a filter from — a destination
// identity, same as the one the running gate is bound to.
const DEFAULT_DESTINATION = 'system:c2-stand-in-atl';

function tallyRefusals(records: DecisionRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.allowed) continue;
    const reason = r.reason ?? 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function DecisionsView({ data }: { data: DecisionsResponse }) {
  const total = data.records.length;
  const tally = tallyRefusals(data.records);

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

      {tally.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {/* A tally alongside the rows, not instead of them — the spec is
              explicit that six refusals sharing a reason must still read as
              six rows below, not one collapsed line. */}
          {tally.map(([reason, count]) => (
            <span key={reason}>
              <span className="font-mono text-rose-300">{count}</span> {reason}
            </span>
          ))}
        </div>
      )}

      {total === 0 ? (
        <div className="text-xs text-slate-500">No records for this destination.</div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-slate-500">
              <th className="pb-1 text-left">asset</th>
              <th className="pb-1 text-left">originator</th>
              <th className="pb-1 text-left">releasable to</th>
              <th className="pb-1 text-left">decision</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.asset_id} className="border-t border-slate-800">
                <td className="py-1 text-slate-300">{r.asset_id}</td>
                <td className="py-1 text-slate-400">{r.originator_nation ?? '—'}</td>
                <td className="py-1 text-slate-400">
                  {r.releasable_to.length > 0 ? r.releasable_to.join(', ') : '—'}
                </td>
                {/* Verbatim from the endpoint. No nation is read here to pick
                    this cell's text or color. */}
                <td className={r.allowed ? 'py-1 text-emerald-300' : 'py-1 text-rose-300'}>
                  {r.allowed ? 'ADMIT' : r.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function EgressAdmissionPane() {
  // An editable field rather than a fixed single-option dropdown: the
  // declared corpus has exactly one destination today, but the endpoint
  // already answers `destination_unknown` for any other name, and an
  // operator being able to try one is how that state gets seen at all.
  const [destinationInput, setDestinationInput] = useState(DEFAULT_DESTINATION);
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const commit = () => setDestination(destinationInput.trim() || DEFAULT_DESTINATION);

  const { data, isLoading, isError, isPolicyUnavailable, policyUnavailableDetail } =
    useEgressAdmission(destination);

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-slate-200">Egress Admission</h3>
        <input
          value={destinationInput}
          onChange={(e) => setDestinationInput(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          spellCheck={false}
          className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
        />
      </div>

      {isPolicyUnavailable ? (
        // Distinct from "0 admitted" on purpose — see useEgressAdmission.ts.
        <div className="text-xs text-amber-300">
          Policy unavailable — the PDP could not be reached
          {policyUnavailableDetail ? `: ${policyUnavailableDetail}` : '.'} This is an outage,
          not a decision that nothing is admitted.
        </div>
      ) : isError ? (
        <div className="text-xs text-rose-400">Could not load admission decisions.</div>
      ) : isLoading && !data ? (
        <div className="text-xs text-slate-500">Loading admission decisions…</div>
      ) : data ? (
        <DecisionsView data={data} />
      ) : (
        <div className="text-xs text-slate-500">No data.</div>
      )}
    </div>
  );
}
