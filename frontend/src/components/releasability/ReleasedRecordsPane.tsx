// =============================================================================
// ReleasedRecordsPane — the mirror of EgressAdmissionPane, for a generic
// `kind`-selected record store (ADR-0046 s5)
// =============================================================================
// Same mechanism, different destination and record shape (ADR-0046's own
// "Neutral" consequence: "The C2 pane and the [sibling] pane are the same
// mechanism with different destinations. A third destination is
// configuration, not code."). `useEgressAdmission` is the SAME hook
// EgressAdmissionPane uses — it already takes a destination (and, now, an
// optional kind) parameter, so nothing about the hook changed for this pane
// to exist.
//
// Unlike EgressAdmissionPane, nothing here is hard-coded: `title`,
// `destination`, `kind` and `columns` all arrive as props, resolved at
// runtime from deployment.json's `releasedRecordsPanes` (see
// deployment.ts). A deployment that configures none gets none; a deployment
// that configures three gets three, each reading its own destination/kind.
//
// COLUMN RENDERING. Each configured column names a JSON pointer (RFC 6901)
// into `record.body` — the generic payload the kind path reads off
// `intake_records` (egress/pane_api.py's `build_decisions`). This file does
// not know what a record "is"; it only knows how to walk a pointer. An
// array or object found at a pointer renders as compact JSON text rather
// than attempting a nested layout — there is no generic way to render an
// arbitrary nested shape, and compact JSON is at least complete and exact.
//
// `ReleasedRecordsView` is exported separately from the default for the
// same reason `DecisionsView` is: a test can render it off an
// endpoint-shaped fixture without exercising the fetch hook
// (react-dom/server's renderToStaticMarkup — no @testing-library/react, no
// jsdom, see vitest.config.ts).
import { Fragment, useState } from 'react';
import {
  useEgressAdmission,
  type DecisionRecord,
  type DecisionsResponse,
} from '../../hooks/useEgressAdmission';
import FigureView from './FigureView';
import { isSafeIcn } from './figure';

export interface ReleasedRecordsColumn {
  header: string;
  /** JSON pointer (RFC 6901, e.g. "/task" or "/parts/0/item") into
   *  `record.body`. An empty string points at the whole body. */
  pointer: string;
}

/** Optional per-row figure: JSON pointers into `record.body` for the figure
 *  number (ICN) a record cites and the applicationStructureIdent of the
 *  object to highlight in it, e.g. an IPD citation's `/citations/ipd/icn` and
 *  `/citations/ipd/hotspot_ids/faulted_section`. */
export interface ReleasedRecordsFigure {
  icnPointer: string;
  applicationStructureIdentPointer: string;
}

export interface ReleasedRecordsPaneProps {
  title: string;
  destination: string;
  kind?: string;
  columns: ReleasedRecordsColumn[];
  figure?: ReleasedRecordsFigure;
}

/** Resolves an RFC 6901 JSON pointer against `root`. Returns `undefined`
 *  when any segment is missing, or when `root` itself is not an
 *  object/array — never throws on a shape it doesn't recognize, since a
 *  misconfigured column should render as a blank cell, not a crash. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  const segments = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const segment of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Arrays and objects render as compact JSON text; everything else renders
 *  as its own string form, with `undefined`/`null` as an em dash. */
function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function tallyRefusals(records: DecisionRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.allowed) continue;
    const reason = r.reason ?? 'unknown';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function ReleasedRecordsView({
  data, columns, figure,
}: {
  data: DecisionsResponse;
  columns: ReleasedRecordsColumn[];
  figure?: ReleasedRecordsFigure;
}) {
  // One figure open at a time, keyed by record.
  const [openKey, setOpenKey] = useState<string | null>(null);
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
              <th className="pb-1 text-left">key</th>
              {columns.map((c) => (
                <th key={c.header} className="pb-1 text-left">{c.header}</th>
              ))}
              <th className="pb-1 text-left">decision</th>
              {figure && <th className="pb-1" />}
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => {
              const rowKey = r.key ?? r.decision_id;
              // Both pointers are resolved against the record body; the icn
              // is only ever used when it is a safe figure number.
              const icn = figure ? resolvePointer(r.body, figure.icnPointer) : undefined;
              const ident = figure ? resolvePointer(r.body, figure.applicationStructureIdentPointer) : undefined;
              const safeIcn = isSafeIcn(icn) ? icn : null;
              const isOpen = safeIcn !== null && openKey === rowKey;
              return (
                <Fragment key={rowKey}>
                  <tr className="border-t border-slate-800">
                    <td className="py-1 text-slate-300">{r.key ?? '—'}</td>
                    {columns.map((c) => (
                      <td key={c.header} className="py-1 text-slate-400">
                        {formatCell(resolvePointer(r.body, c.pointer))}
                      </td>
                    ))}
                    {/* Verbatim from the endpoint, same as EgressAdmissionPane:
                        no nation is read here to pick this cell's text or color. */}
                    <td className={r.allowed ? 'py-1 text-emerald-300' : 'py-1 text-rose-300'}>
                      {r.allowed ? 'ADMIT' : r.reason}
                    </td>
                    {figure && (
                      <td className="py-1 text-right">
                        {safeIcn !== null && (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpenKey(isOpen ? null : rowKey)}
                            className="rounded border border-slate-700 px-1.5 text-[10px] uppercase tracking-widest text-slate-300 hover:border-slate-500"
                          >Figure</button>
                        )}
                      </td>
                    )}
                  </tr>
                  {isOpen && safeIcn !== null && (
                    <tr>
                      <td colSpan={columns.length + 3} className="pb-2">
                        <FigureView
                          icn={safeIcn}
                          applicationStructureIdent={typeof ident === 'string' ? ident : null}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ReleasedRecordsPane({
  title, destination, kind, columns, figure,
}: ReleasedRecordsPaneProps) {
  const { data, isLoading, isError, isPolicyUnavailable, policyUnavailableDetail } =
    useEgressAdmission(destination, kind);

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-slate-200">{title}</h3>
      </div>

      {isPolicyUnavailable ? (
        <div className="text-xs text-amber-300">
          Policy unavailable — the PDP could not be reached
          {policyUnavailableDetail ? `: ${policyUnavailableDetail}` : '.'} This is an outage,
          not a decision that nothing is admitted.
        </div>
      ) : isError ? (
        <div className="text-xs text-rose-400">Could not load released records.</div>
      ) : isLoading && !data ? (
        <div className="text-xs text-slate-500">Loading released records…</div>
      ) : data ? (
        <ReleasedRecordsView data={data} columns={columns} figure={figure} />
      ) : (
        <div className="text-xs text-slate-500">No data.</div>
      )}
    </div>
  );
}
