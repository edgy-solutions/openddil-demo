// =============================================================================
// RegionFleetSummary — Phase 6b §B observable checkpoint panel
// =============================================================================
// Reads region_fleet_summary (populated by the projector's
// region_fleet_summary handler from faust-regional's RegionFleetSummary
// emits — see ADR-0023 §B). One row per region; renders severity counts
// per region as a colored chip bar.
//
// THIS PANEL IS THE §B OBSERVABLE CHECKPOINT. If it shows both regions
// (region-east, region-west) with live-updating severity counts that
// reflect the underlying fleet state, the §B claim ("faust-regional
// does real streaming aggregation; constraint 3 verified on the wire")
// is met visually. Equivalent to the §A EDGE ATTRIBUTION panel one tier
// up.
//
// Cold-start behavior: faust-regional's aggregator skips emit when no
// assets are in the per-region Table yet, so this panel can legitimately
// show "Awaiting first emission..." for either region until cm-state /
// logistics-status / derived-sustainment events arrive for an asset in
// that region. Distinct from "syncing fleet shape" which means
// ElectricSQL hasn't even returned a Shape response yet.

import { useMemo } from 'react';
import { useRegionFleetSummary, useAllTelemetryWindows } from '../../hooks';
import { elementCountsByRegion } from '../../hooks/useTelemetryWindows';

function relativeAge(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const ageS = Math.max(0, (Date.now() - t) / 1000);
  if (ageS < 60) return `${Math.round(ageS)}s ago`;
  if (ageS < 3600) return `${Math.round(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.round(ageS / 3600)}h ago`;
  return `${Math.round(ageS / 86400)}d ago`;
}

const ELEM_TITLE =
  "elements in the critical / degraded band, summed over the region's latest window rollups";

export default function RegionFleetSummary() {
  const rollup = useRegionFleetSummary();
  const windows = useAllTelemetryWindows();
  const elementCounts = useMemo(
    () => elementCountsByRegion(windows.data),
    [windows.data],
  );
  const unattributed = elementCounts.get('')?.rollups ?? 0;

  const rows = useMemo(
    () => [...rollup.data].sort((a, b) => a.region_id.localeCompare(b.region_id)),
    [rollup.data],
  );

  return (
    <div className="panel shrink-0 p-3">
      <h3 className="text-xs text-slate-200 tracking-widest uppercase mb-2 flex items-center justify-between">
        <span>REGION FLEET SUMMARY</span>
        <span className="text-[10px] text-slate-500 normal-case">
          region_fleet_summary live from faust-regional aggregator · element bands from window rollups
        </span>
      </h3>
      {rollup.isLoading && rows.length === 0 ? (
        <div className="text-xs text-slate-500">syncing region shape…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-500">
          Awaiting first emission — no region has been observed yet
        </div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] text-slate-500 uppercase">
              <th className="text-left pb-1">region</th>
              <th className="text-right pb-1">
                <span className="text-emerald-400">nominal</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-amber-400">degraded</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-orange-400">critical</span>
              </th>
              <th className="text-right pb-1" title={ELEM_TITLE}>
                <span className="text-rose-400">elem crit</span>
              </th>
              <th className="text-right pb-1" title={ELEM_TITLE}>
                <span className="text-amber-400">elem deg</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-red-400">N-O</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-slate-400">destroyed</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-slate-400">deactivated</span>
              </th>
              <th className="text-right pb-1">
                <span className="text-slate-400">removed</span>
              </th>
              <th className="text-right pb-1">assets</th>
              <th className="text-right pb-1">observed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.region_id}
                className="text-slate-300 border-t border-slate-800"
              >
                <td className="py-1 text-cyan-300">{r.region_id}</td>
                <td className="py-1 text-right text-emerald-300">{r.nominal}</td>
                <td className="py-1 text-right text-amber-300">{r.degraded}</td>
                <td className="py-1 text-right text-orange-300">{r.critical}</td>
                <td
                  className="py-1 text-right text-rose-300"
                  data-testid={`region-elements-critical-${r.region_id}`}
                >
                  {elementCounts.get(r.region_id)?.critical ?? '—'}
                </td>
                <td
                  className="py-1 text-right text-amber-300"
                  data-testid={`region-elements-degraded-${r.region_id}`}
                >
                  {elementCounts.get(r.region_id)?.degraded ?? '—'}
                </td>
                <td className="py-1 text-right text-red-300">{r.non_operational}</td>
                <td className="py-1 text-right text-slate-300">{r.destroyed}</td>
                <td className="py-1 text-right text-slate-300">{r.deactivated}</td>
                <td className="py-1 text-right text-slate-300">{r.removed}</td>
                <td className="py-1 text-right">{r.asset_count}</td>
                <td className="py-1 text-right text-slate-400">
                  {relativeAge(r.observed_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unattributed > 0 && (
        <div
          className="mt-1 text-[10px] text-slate-500"
          data-testid="region-elements-unattributed"
        >
          {unattributed} element rollup(s) without a region
        </div>
      )}
    </div>
  );
}
