// =============================================================================
// useMyReports / useTierReports -- the viewer's fault reports as a timeline
// =============================================================================
// GET /reports/mine and GET /reports/tier on the PEP (ADR-0058, slice 3a).
// Each report carries `states[]`: one row per state, each with its own source
// (owner) and time. There is NO overall status here or in the pane that draws
// it; the hook hands the rows through in the order the server sent them.
// Polled every 15 s while mounted, like useCortexCases. A 403 from the tier
// route is an answer (the body's `state` text), not a failure.
import { useEffect, useState } from 'react';

export interface ReportState {
  state: string;
  source?: string | null;
  at?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface Report {
  episode_id: string;
  detected_at?: string | null;
  asset_id?: string | null;
  component?: string | null;
  fault_code?: string | null;
  open?: boolean;
  cleared_at?: string | null;
  cleared_by?: string | null;
  resolution?: string | null;
  states: ReportState[];
  unmatched?: unknown[];
}

export interface ReportsResult {
  /** undefined until the first answer. */
  reports: Report[] | undefined;
  unmatchedLedger: unknown[];
  /** The server's named state text: empty list, or a 403's reason. */
  stateText: string | null;
  forbidden: boolean;
  /** A failure other than a 403. Draws a line; never hides rows already read. */
  error: string | null;
}

export const REPORTS_POLL_MS = 15_000;
export const MY_REPORTS_URL = '/reports/mine';
export const TIER_REPORTS_URL = '/reports/tier';

const INITIAL: ReportsResult = {
  reports: undefined, unmatchedLedger: [], stateText: null, forbidden: false, error: null,
};

function useReports(url: string, enabled: boolean): ReportsResult {
  const [result, setResult] = useState<ReportsResult>(INITIAL);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let failing = false;
    const load = async () => {
      try {
        const res = await fetch(url);
        let body: Record<string, unknown> | null = null;
        try { body = await res.json(); } catch { body = null; }
        if (cancelled) return;
        if (res.status === 403) {
          failing = false;
          setResult({
            reports: [], unmatchedLedger: [], forbidden: true, error: null,
            stateText: typeof body?.state === 'string' ? body.state : 'forbidden',
          });
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        failing = false;
        const reports = Array.isArray(body?.reports) ? (body.reports as Report[]) : [];
        setResult({
          reports,
          unmatchedLedger: Array.isArray(body?.unmatched_ledger) ? (body.unmatched_ledger as unknown[]) : [],
          stateText: typeof body?.state === 'string' ? body.state : null,
          forbidden: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        // Keep rows already read; name the failure beside them.
        setResult((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
        if (!failing) {
          failing = true;
          console.warn('[reports] fetch failed:', err);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), REPORTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, enabled]);

  return enabled ? result : INITIAL;
}

export function useMyReports(enabled = true): ReportsResult {
  return useReports(MY_REPORTS_URL, enabled);
}

export function useTierReports(enabled = true): ReportsResult {
  return useReports(TIER_REPORTS_URL, enabled);
}
