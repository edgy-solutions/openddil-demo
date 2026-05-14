// =============================================================================
// TelemetryCharts — per-asset sustainment telemetry, platform-variant-aware
// =============================================================================
// Phase 4b rewrite. Was keyed by the mock simulator's coarse asset TYPE
// (RADAR/LASER_SHORAD/...) and read bare-double fields. Now keyed by
// `platform_variant` (see config/platformChartConfig.ts) and reads
// `sustainment.*` Quantity leaves ({ value, unit }) from the real
// telemetry_latest_state shape.
//
// Schema-drift reality: the OSS DIS feed carries kinematics only — no
// sustainment. When `sustainment` is absent the component renders an
// explicit empty state rather than charting zeros.
import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { TelemetryLatest, Quantity } from '../hooks';
import { platformChartConfig, type ChartField } from '../config/platformChartConfig';

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

interface TelemetryChartsProps {
  telemetry: TelemetryLatest | null;
  platformVariant: string | null;
  degraded: boolean;
}

export default function TelemetryCharts({ telemetry, platformVariant, degraded }: TelemetryChartsProps) {
  const config = platformChartConfig(platformVariant);
  const sustainment = telemetry?.sustainment ?? null;
  const hasSustainment =
    sustainment != null &&
    typeof sustainment === 'object' &&
    Object.keys(sustainment).length > 0;

  // One canvas ref per configured field.
  const chartRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const chartInstances = useRef<(Chart | undefined)[]>([]);
  const dataHistories = useRef<number[][]>([]);
  const prevVariant = useRef<string | null>(null);

  // (Re)build charts when the platform variant changes.
  useEffect(() => {
    if (!hasSustainment) return;
    if (prevVariant.current !== platformVariant) {
      dataHistories.current = config.fields.map(() => Array(HISTORY).fill(0));
      prevVariant.current = platformVariant;
    }
    config.fields.forEach((_field, idx) => {
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
  }, [platformVariant, hasSustainment, config.fields]);

  // Push new samples whenever telemetry updates.
  useEffect(() => {
    if (!hasSustainment) return;
    config.fields.forEach((field, idx) => {
      const q = readQuantity(sustainment, field);
      const val = q?.value ?? 0;
      const hist = dataHistories.current[idx];
      if (!hist) return;
      hist.push(val);
      hist.shift();
      const isAnomaly = field.anomalyThreshold != null && val >= field.anomalyThreshold;
      const color = isAnomaly || degraded ? '#f43f5e' : '#22d3ee';
      const inst = chartInstances.current[idx];
      if (inst) {
        inst.data.datasets[0].borderColor = color;
        inst.update();
      }
    });
  }, [telemetry, degraded, hasSustainment, sustainment, config.fields]);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-4 flex items-center">
        <Activity className="w-4 h-4 mr-2" /> Prognostics &amp; Telemetry
      </h2>

      {!hasSustainment && (
        <div className="text-xs text-slate-500 border border-slate-700 bg-slate-800/50 p-3 rounded-sm">
          No sustainment telemetry yet — derived prognostics from kinematic
          history are not yet wired for DIS-sourced assets. Measured
          sustainment arrives via the sim-a / proprietary feeds.
          <span className="block mt-1 opacity-60">See ADR-0020 (Prognostics Derivation Stage).</span>
        </div>
      )}

      {hasSustainment && config.fields.map((field, idx) => {
        const q = readQuantity(sustainment, field);
        const val = q?.value ?? 0;
        const unit = q?.unit ?? '';
        const isAnomaly = field.anomalyThreshold != null && val >= field.anomalyThreshold;
        return (
          <div key={field.path} className="mb-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-300">{field.label}</span>
              <span className={`font-bold ${isAnomaly || degraded ? 'text-rose-400 glow-rose' : 'text-cyan-400'}`}>
                {q ? `${val.toFixed(1)} ${unit}` : 'n/a'}
              </span>
            </div>
            <div className="h-24 w-full relative">
              <canvas ref={(el) => { chartRefs.current[idx] = el; }}></canvas>
            </div>
          </div>
        );
      })}
    </div>
  );
}
