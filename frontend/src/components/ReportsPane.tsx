// =============================================================================
// ReportsPane -- "My reports" (and a supervisor's tier reports) as timelines
// =============================================================================
// ADR-0058 slice 3a. One row per state of a report: the state, its source
// (the owner of that step) and its time, plus detail. NO combined status: no
// badge, no overall colour, no role="status" per report (design section 8).
// Rows are drawn in the order the server sent them. "unmatched" items are
// always listed.
import { useMyReports, useTierReports, type Report, type ReportState, type ReportsResult } from '../hooks/useReports';

function fmt(iso: string | null | undefined): string {
  if (!iso) return 'no time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { hour12: false });
}

function detailText(detail: ReportState['detail']): string {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      // A bare note ("read in 3b") reads as itself; keyed detail as key: value.
      return k === 'read' || k === 'note' ? String(val) : `${k}: ${val}`;
    })
    .join('; ');
}

function unmatchedText(item: unknown): string {
  return typeof item === 'string' ? item : JSON.stringify(item);
}

function ReportItem({ report }: { report: Report }) {
  const states = Array.isArray(report.states) ? report.states : [];
  return (
    <li className="border border-slate-700/60 rounded-sm p-2" data-testid="report-item">
      <div className="font-mono text-[11px] text-slate-200">
        {report.asset_id ?? 'asset'}{report.component ? ` / ${report.component}` : ''}
        {report.fault_code ? ` / ${report.fault_code}` : ''}
      </div>
      <div className="font-mono text-[10px] text-slate-500">
        {report.episode_id} - detected {fmt(report.detected_at)}
      </div>
      {report.open === false && (
        <div className="font-mono text-[10px] text-slate-400" data-testid="report-closed">
          cleared_at {fmt(report.cleared_at)}; cleared_by {report.cleared_by ?? 'unknown'}; resolution {report.resolution ?? 'none'}
        </div>
      )}
      <ol className="mt-1 flex flex-col gap-0.5">
        {states.map((s, i) => {
          const detail = detailText(s.detail);
          return (
            <li key={`${s.state}|${i}`} className="font-mono text-[11px] text-slate-300" data-testid="report-state-row">
              <span className="font-bold">{s.state}</span>
              <span className="text-slate-500"> - source {s.source ?? 'none'} - {fmt(s.at)}</span>
              {detail && <span className="text-slate-400"> - {detail}</span>}
            </li>
          );
        })}
        {states.length === 0 && (
          <li className="font-mono text-[11px] text-slate-500">no states returned</li>
        )}
      </ol>
      {(report.unmatched ?? []).map((u, i) => (
        <div key={i} className="font-mono text-[11px] text-slate-400" data-testid="report-unmatched">
          unmatched: {unmatchedText(u)}
        </div>
      ))}
    </li>
  );
}

export function ReportsList({ title, result }: { title: string; result: ReportsResult }) {
  const { reports, unmatchedLedger, stateText, error } = result;
  return (
    <section className="panel flex flex-col gap-2" aria-label={title} data-testid="reports-pane">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">{title}</h3>
      {reports === undefined && !error && <div className="text-xs text-slate-500">loading</div>}
      {error && <div className="text-xs text-slate-400">reports fetch failed: {error}</div>}
      {reports !== undefined && reports.length === 0 && stateText && (
        <div className="text-xs text-slate-400" data-testid="reports-state-text">{stateText}</div>
      )}
      {reports !== undefined && reports.length > 0 && (
        <ul className="flex flex-col gap-2">
          {reports.map((r) => <ReportItem key={r.episode_id} report={r} />)}
        </ul>
      )}
      {unmatchedLedger.map((u, i) => (
        <div key={i} className="font-mono text-[11px] text-slate-400" data-testid="ledger-unmatched">
          unmatched: {unmatchedText(u)}
        </div>
      ))}
    </section>
  );
}

export function MyReportsPane() {
  return <ReportsList title="My reports" result={useMyReports()} />;
}

export function TierReportsPane() {
  return <ReportsList title="Reports at this tier" result={useTierReports()} />;
}

/** My reports always; the tier's reports too when the session's role is
 *  supervisor. The role only offers the panel; the PEP's 403 still answers. */
export default function ReportsPane({ role }: { role?: string | null }) {
  return (
    <>
      <MyReportsPane />
      {role === 'supervisor' && <TierReportsPane />}
    </>
  );
}
