// =============================================================================
// ArrivalsSummary -- HQ's per-edge arrivals counts (ADR-0050 s5)
// =============================================================================
// Reads GET /arrivals/summary, a PEP route that counts only (no ids). It
// deliberately does not derive anything from region_fleet_summary: that table
// keeps emptied class buckets frozen, so a relabelled asset would count twice.

import { useEffect, useState } from 'react';
import {
  formatArrivalsSummary,
  loadArrivalsSummary,
  type LoadArrivalsSummaryResult,
} from '../../lib/arrivals';

const REFRESH_MS = 15_000;

export default function ArrivalsSummary() {
  const [result, setResult] = useState<LoadArrivalsSummaryResult | null>(null);

  useEffect(() => {
    let live = true;
    const tick = () => {
      void loadArrivalsSummary().then((r) => {
        if (live) setResult(r);
      });
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (result?.kind === 'absent') return null;

  return (
    <div className="panel shrink-0 p-3">
      <h3 className="text-xs text-slate-200 tracking-widest uppercase mb-2">Arrivals</h3>
      {result === null ? (
        <div className="text-xs text-slate-500">Loading…</div>
      ) : result.kind === 'error' ? (
        <div className="text-xs text-slate-500">Arrivals summary unavailable</div>
      ) : result.data.length === 0 ? (
        <div className="text-xs text-slate-500">No edges reporting</div>
      ) : (
        <ul className="text-xs font-mono space-y-1">
          {result.data.map((e) => (
            <li
              key={e.edge_id}
              data-testid="arrivals-summary-row"
              className={`flex justify-between gap-3 ${
                e.undeclared > 0 || e.overdue > 0 ? 'text-amber-400' : 'text-slate-300'
              }`}
            >
              <span>{e.edge_id}</span>
              <span>{formatArrivalsSummary(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
