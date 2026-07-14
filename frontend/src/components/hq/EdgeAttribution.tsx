// =============================================================================
// EdgeAttribution — Phase 6a observable checkpoint panel
// =============================================================================
// Reads telemetry_latest_state.edge_id / region_id (populated by the
// projector's telemetry_latest handler from message-field Provenance) and
// groups by edge_id. Renders edge × region × asset-count × in-flight-count
// × latest-sample.
//
// Real data, no DEMO_MOCK banner — this panel IS the verification that the
// per-edge attribution path works end-to-end. If it shows N distinct edges
// with their assigned region and live asset counts, ADR-0023 §6a's
// checkpoint claim ("per-edge attribution flows through the pipeline
// end-to-end") is met visually.
//
// 2026-07-14: split the count into two columns.
//   * ASSETS    -- hardware only (SENSOR + LAUNCHER + FACILITY + PLATFORM).
//                  Stable during a scenario; doesn't oscillate as
//                  transient munition rows appear and TTL out.
//   * IN FLIGHT -- MUNITION-class rows deduped per firing (delivery
//                  vehicle + seeker payload collapse to one) using the
//                  shared dedupFirings helper. Matches FORCE POSTURE,
//                  Enterprise Fleet Tree, Regional Sustainment Posture,
//                  and per-launcher Loadout Card counts.
// The split adds a second diagnostic axis to this checkpoint panel: if
// munition-row edge_id stamping is broken, the IN FLIGHT column stays
// at 0 during a scenario -- a signal you wouldn't otherwise see.
import { useMemo } from 'react';
import {
  useClassifiedFleet,
  type ClassifiedFleetAsset,
} from '../../hooks';
import { dedupFirings } from '../../lib/munitionAsset';

interface EdgeRow {
  edge_id: string;
  region_id: string;
  hardware_count: number;
  inflight_count: number;
  latest_sample_at: string | null;
}

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

export default function EdgeAttribution() {
  const fleet = useClassifiedFleet();

  const rows = useMemo<EdgeRow[]>(() => {
    // Split into hardware vs. in-flight ONCE, then dedup the in-flight
    // side globally so the per-edge sums equal what every other view
    // reports for total in-flight. Dedup must happen BEFORE bucketing
    // by edge -- otherwise the delivery-vehicle row and its seeker-
    // payload row could land on different edges (they always share
    // edge_id in practice, but this keeps the semantics tight).
    const hardware: ClassifiedFleetAsset[] = [];
    const inflightRaw: ClassifiedFleetAsset[] = [];
    for (const a of fleet.data) {
      if (a.asset_class === 'MUNITION') inflightRaw.push(a);
      else hardware.push(a);
    }
    const inflight = dedupFirings(inflightRaw);

    const byEdge = new Map<string, EdgeRow>();
    const ensure = (edge: string, region: string): EdgeRow => {
      let row = byEdge.get(edge);
      if (!row) {
        row = {
          edge_id: edge,
          region_id: region,
          hardware_count: 0,
          inflight_count: 0,
          latest_sample_at: null,
        };
        byEdge.set(edge, row);
      }
      return row;
    };

    for (const a of hardware) {
      const edge = a.edge_id ?? 'edge-unknown';
      const region = a.region_id ?? 'region-unknown';
      const row = ensure(edge, region);
      row.hardware_count += 1;
      if (a.last_sample_at && (!row.latest_sample_at ||
          new Date(a.last_sample_at) > new Date(row.latest_sample_at))) {
        row.latest_sample_at = a.last_sample_at;
      }
    }
    for (const a of inflight) {
      const edge = a.edge_id ?? 'edge-unknown';
      const region = a.region_id ?? 'region-unknown';
      const row = ensure(edge, region);
      row.inflight_count += 1;
      if (a.last_sample_at && (!row.latest_sample_at ||
          new Date(a.last_sample_at) > new Date(row.latest_sample_at))) {
        row.latest_sample_at = a.last_sample_at;
      }
    }
    return Array.from(byEdge.values()).sort((a, b) =>
      a.edge_id.localeCompare(b.edge_id)
    );
  }, [fleet.data]);

  return (
    <div className="panel shrink-0 p-3">
      <h3 className="text-xs text-slate-200 tracking-widest uppercase mb-2 flex items-center justify-between">
        <span>EDGE ATTRIBUTION</span>
        <span className="text-[10px] text-slate-500 normal-case">
          telemetry_latest_state grouped by edge_id
        </span>
      </h3>
      {fleet.isLoading && rows.length === 0 ? (
        <div className="text-xs text-slate-500">syncing fleet shape…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-500">
          no telemetry yet — drive a DIS PDU into any edge to populate
        </div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] text-slate-500 uppercase">
              <th className="text-left pb-1">edge</th>
              <th className="text-left pb-1">region</th>
              <th className="text-right pb-1">assets</th>
              <th className="text-right pb-1">in flight</th>
              <th className="text-right pb-1">latest sample</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.edge_id} className="text-slate-300 border-t border-slate-800">
                <td className="py-1 text-emerald-400">{r.edge_id}</td>
                <td className="py-1 text-slate-400">{r.region_id}</td>
                <td className="py-1 text-right tabular-nums">{r.hardware_count}</td>
                <td className={`py-1 text-right tabular-nums ${
                  r.inflight_count > 0 ? 'text-amber-400 font-bold' : 'text-slate-600'
                }`}>
                  {r.inflight_count > 0 ? r.inflight_count : '—'}
                </td>
                <td className="py-1 text-right text-slate-400">
                  {relativeAge(r.latest_sample_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
