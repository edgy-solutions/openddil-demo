// =============================================================================
// TelemetryCharts — per-asset sustainment telemetry, platform-variant-aware
// =============================================================================
// Layered data sources (priority high → low):
//
//   1. REAL SUSTAINMENT: `telemetry.sustainment.*` Quantity leaves on the
//      telemetry_latest_state row. This is the canonical source — actual
//      sustainment data from the customer / DIS feed (when they emit it).
//      Charts read engineered fields per platformChartConfig (engine
//      thermal, gearbox vibration, array thermal matrix, etc.).
//
//   2. SIM-DERIVED AGGREGATES: when sustainment is absent but the
//      logistics-sim is emitting per-element snapshots for this asset,
//      we aggregate those into a 4-stat sim-derived panel
//      (CRITICAL ELEMENTS / DEGRADED ELEMENTS / AVG ELEMENT TEMP /
//      AVG ELEMENT LOAD). Clearly badged as SYNTHESIZED so an operator
//      doesn't confuse it with the real-sustainment path.
//
//   3. EMPTY STATE: no sustainment AND no sim element data → existing
//      "telemetry not yet wired" copy.
//
// The instant the customer/DIS feed starts emitting `sustainment.*`,
// the card switches back to the real-sustainment path automatically —
// the sim-derived panel is fallback only.
//
// Schema-drift reality: the OSS DIS feed carries kinematics only — no
// sustainment. The customer-overlay proprietary feed for MRAD assets
// also doesn't fill sustainment today. logistics-sim's per-element
// synthesis is the closest stand-in available, hence the fallback.
import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { TelemetryLatest, Quantity } from '../hooks';
import { platformChartConfig, type ChartField } from '../config/platformChartConfig';
import { SyncingNotice } from './SyncingNotice';
import type { LiveElementTelemetry } from './SensorArrayView';

Chart.register(...registerables);
Chart.defaults.color = '#64748b';
Chart.defaults.font.family = 'monospace';

const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  scales: {
    x: { display: false },
    y: { border: { display: false }, grid: { color: '#1e293b', drawTicks: false }, ticks: { maxTicksLimit: 4, font: { size: 9 } } },
  },
  animation: { duration: 0 },
};

const HISTORY = 30;

// Severity thresholds — match SensorArrayView's getStatusFromHealth +
// the sim's element_gen.py. CRITICAL > 0.97, DEGRADED > 0.90 ≤ 0.97.
const HEALTH_CRITICAL = 0.97;
const HEALTH_DEGRADED = 0.90;

/** Navigate a dot-path into a nested object; undefined if any hop is missing. */
function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Pull a Quantity {value, unit} from the sustainment blob at a field's path. */
function readQuantity(sustainment: any, field: ChartField): Quantity | null {
  const q = getByPath(sustainment, field.path);
  if (q && typeof q === 'object' && typeof q.value === 'number') {
    return { value: q.value, unit: typeof q.unit === 'string' ? q.unit : '' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source-agnostic field model. Both sustainment fields and sim-derived
// aggregates render through the same chart loop -- this is what they
// flatten to.
// ---------------------------------------------------------------------------
interface ResolvedField {
  /** Stable id used for rolling-history keying. Must be unique within
   *  the field list for a given source so React doesn't collide
   *  histories across renders. */
  id: string;
  label: string;
  unit: string;
  anomalyThreshold?: number;
  value: number;
  /** False when sustainment lookup didn't find the field (rendered as
   *  "n/a"). Always true for sim-derived (we compute a number). */
  hasValue: boolean;
}

type FieldSource = 'sustainment' | 'sim' | 'empty';

// ---------------------------------------------------------------------------
// Sim-derived aggregation -- collapses per-element telemetry into 4
// chartable stats. The narrative the maintainer-demo wants the
// operator to read off the card:
//
//   * CRITICAL ELEMENTS climbs the moment the proprietary sim reports
//     HEALTH_STATE_FAULT or FAILED — pairs with the 3D view's red tiles.
//   * DEGRADED ELEMENTS climbs at DEGRADED upward — pairs with yellows.
//   * AVG ELEMENT TEMP gives a thermal scalar that drifts with load.
//   * AVG ELEMENT LOAD gives a utilization scalar.
//
// Thresholds picked so the chart line turns rose-red when the asset is
// in a state the operator should care about — CRITICAL count > 0 fires
// immediately, DEGRADED count fires at 50 (gives a buffer for the
// nominal "a few elements drift up" RNG noise).
// ---------------------------------------------------------------------------
interface SimDerivedField {
  id: string;
  label: string;
  unit: string;
  anomalyThreshold?: number;
  readValue: (live: LiveElementTelemetry) => number;
}

const SIM_DERIVED_FIELDS: SimDerivedField[] = [
  {
    id: 'sim.critical_elements',
    label: 'CRITICAL ELEMENTS',
    unit: '',
    anomalyThreshold: 1, // any red element fires anomaly
    readValue: (live) => {
      let n = 0;
      for (const e of Object.values(live)) {
        if (e.health > HEALTH_CRITICAL) n++;
      }
      return n;
    },
  },
  {
    id: 'sim.degraded_elements',
    label: 'DEGRADED ELEMENTS',
    unit: '',
    anomalyThreshold: 50,
    readValue: (live) => {
      let n = 0;
      for (const e of Object.values(live)) {
        if (e.health > HEALTH_DEGRADED && e.health <= HEALTH_CRITICAL) n++;
      }
      return n;
    },
  },
  {
    id: 'sim.avg_element_temp',
    label: 'AVG ELEMENT TEMP',
    unit: '°C',
    readValue: (live) => {
      let sum = 0;
      let count = 0;
      for (const e of Object.values(live)) {
        if (typeof e.temp === 'number') {
          sum += e.temp;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    },
  },
  {
    id: 'sim.avg_element_load',
    label: 'AVG ELEMENT LOAD',
    unit: '%',
    readValue: (live) => {
      let sum = 0;
      let count = 0;
      for (const e of Object.values(live)) {
        if (typeof e.load === 'number') {
          sum += e.load;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    },
  },
];

/** Has the sim hook delivered any per-element data for this asset yet? */
function hasSimElements(live: LiveElementTelemetry | undefined): boolean {
  return !!live && Object.keys(live).length > 0;
}

/** Resolve the active field list + source for a given (sustainment,
 *  liveTelemetry) pair. Priority: sustainment > sim > empty. */
function resolveFields(
  config: ReturnType<typeof platformChartConfig>,
  sustainment: any,
  liveTelemetry: LiveElementTelemetry | undefined,
): { fields: ResolvedField[]; source: FieldSource } {
  const hasSustainment =
    sustainment != null &&
    typeof sustainment === 'object' &&
    Object.keys(sustainment).length > 0;

  if (hasSustainment) {
    return {
      fields: config.fields.map((f) => {
        const q = readQuantity(sustainment, f);
        return {
          id: 'sustainment.' + f.path,
          label: f.label,
          unit: q?.unit ?? '',
          anomalyThreshold: f.anomalyThreshold,
          value: q?.value ?? 0,
          hasValue: q != null,
        };
      }),
      source: 'sustainment',
    };
  }

  if (hasSimElements(liveTelemetry)) {
    return {
      fields: SIM_DERIVED_FIELDS.map((f) => ({
        id: f.id,
        label: f.label,
        unit: f.unit,
        anomalyThreshold: f.anomalyThreshold,
        value: f.readValue(liveTelemetry!),
        hasValue: true,
      })),
      source: 'sim',
    };
  }

  return { fields: [], source: 'empty' };
}

interface TelemetryChartsProps {
  telemetry: TelemetryLatest | null;
  platformVariant: string | null;
  degraded: boolean;
  /** Telemetry shape's first sync not yet complete (cold-start). */
  isLoading?: boolean;
  /** Per-element snapshot from useAssetElementTelemetry. When present
   *  AND sustainment is absent, the card switches into sim-derived
   *  mode (4-stat aggregate panel + SYNTHESIZED badge). Falls back
   *  to empty state when both are missing. */
  liveTelemetry?: LiveElementTelemetry;
}

export default function TelemetryCharts({
  telemetry,
  platformVariant,
  degraded,
  isLoading = false,
  liveTelemetry,
}: TelemetryChartsProps) {
  const config = platformChartConfig(platformVariant);
  const sustainment = telemetry?.sustainment ?? null;
  const { fields, source } = resolveFields(config, sustainment, liveTelemetry);

  // One canvas ref per resolved field. Re-created when source or
  // platformVariant flips (different field list, different histories).
  const chartRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const chartInstances = useRef<(Chart | undefined)[]>([]);
  const dataHistories = useRef<number[][]>([]);
  // Rebuild key: source + variant + field count. When ANY of these
  // change, the chart set is rebuilt and histories reset.
  const prevRebuildKey = useRef<string | null>(null);

  const rebuildKey = `${source}|${platformVariant ?? '-'}|${fields.length}`;

  // (Re)build charts when the resolved field set changes.
  useEffect(() => {
    if (source === 'empty') return;
    if (prevRebuildKey.current !== rebuildKey) {
      dataHistories.current = fields.map(() => Array(HISTORY).fill(0));
      prevRebuildKey.current = rebuildKey;
    }
    fields.forEach((_f, idx) => {
      const ref = chartRefs.current[idx];
      if (!ref) return;
      chartInstances.current[idx]?.destroy();
      const ctx = ref.getContext('2d')!;
      const grad = ctx.createLinearGradient(0, 0, 0, 100);
      grad.addColorStop(0, 'rgba(34, 211, 238, 0.5)');
      grad.addColorStop(1, 'rgba(34, 211, 238, 0.0)');
      chartInstances.current[idx] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: Array.from({ length: HISTORY }, (_, i) => i),
          datasets: [{
            data: dataHistories.current[idx],
            borderColor: '#22d3ee',
            backgroundColor: grad,
            borderWidth: 1.5,
            fill: true,
            pointRadius: 0,
            tension: 0.4,
          }],
        },
        options: commonOptions,
      });
    });
    return () => {
      chartInstances.current.forEach((c) => c?.destroy());
      chartInstances.current = [];
    };
  }, [rebuildKey, source, fields.length]);

  // Push new samples whenever values update. Note: `fields` is a fresh
  // array each render; we lean on `rebuildKey` to detect structural
  // changes and just read values out here on every render.
  useEffect(() => {
    if (source === 'empty') return;
    fields.forEach((field, idx) => {
      const hist = dataHistories.current[idx];
      if (!hist) return;
      hist.push(field.value);
      hist.shift();
      const isAnomaly =
        field.anomalyThreshold != null && field.value >= field.anomalyThreshold;
      const color = isAnomaly || degraded ? '#f43f5e' : '#22d3ee';
      const inst = chartInstances.current[idx];
      if (inst) {
        inst.data.datasets[0].borderColor = color;
        inst.update();
      }
    });
    // Recompute the values via the field list each render -- the
    // values themselves are derived from props on every render so
    // we don't need a deeper dep array.
  });

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-4 flex items-center justify-between">
        <span className="flex items-center">
          <Activity className="w-4 h-4 mr-2" /> Prognostics &amp; Telemetry
        </span>
        {source === 'sim' && (
          // SYNTHESIZED badge -- distinguishes sim-derived aggregates
          // from real sustainment. Same color family as the existing
          // DEMO MOCK marker so the operator recognizes the provenance
          // signal at a glance.
          <span
            className="text-[9px] font-mono tracking-widest text-amber-400 border border-amber-700/50 bg-amber-900/30 px-2 py-0.5 rounded-sm"
            title="Per-element aggregates synthesized by logistics-sim. Real sustainment will replace this view automatically when the customer / DIS feed emits sustainment.* fields."
          >
            SYNTHESIZED
          </span>
        )}
      </h2>

      {/* syncing -> (synced, no sustainment, no sim) -> (sim-derived) ->
          (real sustainment). The syncing state must never fall through
          to the "no sustainment" copy (cold-start race). */}
      {isLoading && <SyncingNotice label="Syncing telemetry…" />}

      {!isLoading && source === 'empty' && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-3 rounded-sm">
          No sustainment telemetry yet — derived prognostics from kinematic
          history are not yet wired for DIS-sourced assets. Measured
          sustainment arrives via the sim-a / proprietary feeds.
          <span className="block mt-1 opacity-60">See ADR-0020 (Prognostics Derivation Stage).</span>
        </div>
      )}

      {!isLoading && source !== 'empty' && (
        <>
          {source === 'sim' && (
            <p className="text-[10px] font-mono text-amber-300/70 mb-3 leading-snug">
              Real sustainment is not yet wired for this asset. Showing
              per-element rollups synthesized by logistics-sim — the
              same data driving the 3D drill-down above. When the
              upstream feed begins emitting sustainment.*, this panel
              will switch back to real measurements automatically.
            </p>
          )}
          {fields.map((field, idx) => {
            const isAnomaly =
              field.anomalyThreshold != null && field.value >= field.anomalyThreshold;
            const displayValue = field.hasValue
              ? `${field.value.toFixed(field.unit === '' ? 0 : 1)}${field.unit ? ' ' + field.unit : ''}`
              : 'n/a';
            return (
              <div key={field.id} className="mb-4">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">{field.label}</span>
                  <span className={`font-bold ${isAnomaly || degraded ? 'text-rose-400 glow-rose' : 'text-cyan-400'}`}>
                    {displayValue}
                  </span>
                </div>
                <div className="h-24 w-full relative">
                  <canvas ref={(el) => { chartRefs.current[idx] = el; }}></canvas>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
