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
//   * IN FLIGHT -- in-flight munition_track rows (ADR-0049), the same rows
//                  FORCE POSTURE, Enterprise Fleet Tree, Regional
//                  Sustainment Posture and the Loadout Card count.
// The split adds a second diagnostic axis to this checkpoint panel: if
// munition_track edge_id stamping is broken, the IN FLIGHT column stays
// at 0 during a scenario -- a signal you wouldn't otherwise see.
import { useMemo } from 'react';
import {
  useClassifiedFleet,
  useInFlightMunitionTracks,
  type ClassifiedFleetAsset,
} from '../../hooks';
import { edgeAttachment } from '../../deployment';

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
  const tracks = useInFlightMunitionTracks();

  const rows = useMemo<EdgeRow[]>(() => {
    // Hardware comes from the fleet (MUNITION-class rows stay out: the upstream
    // feed still models munitions as assets). In flight comes from the
    // munition_track rows (ADR-0049), bucketed by the row's own edge_id, else
    // its launcher's edge.
    const hardware: ClassifiedFleetAsset[] = fleet.data.filter((a) => a.asset_class !== 'MUNITION');
    const launcherById = new Map(hardware.map((a) => [a.asset_id, a]));

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
    for (const t of tracks.data) {
      const lau = t.launcherAssetId ? launcherById.get(t.launcherAssetId) : undefined;
      const edge = t.edgeId ?? lau?.edge_id ?? 'edge-unknown';
      const region = t.regionId ?? lau?.region_id ?? 'region-unknown';
      const row = ensure(edge, region);
      row.inflight_count += 1;
      if (t.lastSampleAt && (!row.latest_sample_at ||
          new Date(t.lastSampleAt) > new Date(row.latest_sample_at))) {
        row.latest_sample_at = t.lastSampleAt;
      }
    }
    return Array.from(byEdge.values()).sort((a, b) =>
      a.edge_id.localeCompare(b.edge_id)
    );
  }, [fleet.data, tracks.data]);

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
                <td className="py-1 text-emerald-400">
                  {r.edge_id}
                  {edgeAttachment(r.edge_id) === 'hq' && (
                    <span
                      className="ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border border-cyan-700/50 bg-cyan-900/30 text-cyan-300 uppercase rounded-sm cursor-help"
                      title="Writes straight to HQ. No edge store: this is not edge data that survives a WAN cut."
                    >
                      HQ-ATTACHED
                    </span>
                  )}
                </td>
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
