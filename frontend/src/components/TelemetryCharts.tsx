import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
Chart.defaults.color = '#64748b';
Chart.defaults.font.family = 'monospace';

const commonOptions = {
    responsive: true, 
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
        x: { display: false },
        y: { border: { display: false }, grid: { color: '#1e293b', drawTicks: false }, ticks: { maxTicksLimit: 4, font: { size: 9 } } }
    },
    animation: { duration: 0 }
};

export const ASSET_CONFIGS: Record<string, any> = {
  'RADAR': {
    fields: [
      { key: 'core_temp', label: 'Primary Array Thermal Matrix', unit: '°C', min: 20, max: 100, anomalyThreshold: 85 },
      { key: 'coolant_pressure', label: 'Coolant System Pressure', unit: 'PSI', min: 0, max: 200, anomalyThreshold: 180 }
    ]
  },
  'LASER_SHORAD': {
    fields: [
      { key: 'cavity_temp', label: 'Laser Cavity Temperature', unit: '°C', min: 20, max: 200, anomalyThreshold: 140 },
      { key: 'pump_rpm', label: 'Cooling Pump Speed', unit: 'RPM', min: 0, max: 6000, anomalyThreshold: 5500 }
    ]
  },
  'ARTILLERY': {
    fields: [
      { key: 'hydraulic_pressure', label: 'Hydraulic System Pressure', unit: 'PSI', min: 0, max: 4000, anomalyThreshold: 3500 },
      { key: 'elevation_angle', label: 'Pod Elevation Angle', unit: 'DEG', min: 0, max: 90, anomalyThreshold: 85 }
    ]
  },
  'QUADRUPED': {
    fields: [
      { key: 'joint_torque', label: 'Actuator Joint Torque', unit: 'Nm', min: 0, max: 50, anomalyThreshold: 40 },
      { key: 'battery_discharge', label: 'Battery Discharge Rate', unit: 'kW', min: 0, max: 20, anomalyThreshold: 15 }
    ]
  }
};

interface TelemetryChartsProps {
  assetType: string;
  telemetry: any;
  degraded: boolean;
}

export default function TelemetryCharts({ assetType, telemetry, degraded }: TelemetryChartsProps) {
  const chartRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const chartInstances = useRef<(Chart | undefined)[]>([]);
  const dataHistories = useRef<number[][]>([Array(30).fill(0), Array(30).fill(0)]);
  const prevAssetType = useRef(assetType);

  const config = ASSET_CONFIGS[assetType] || ASSET_CONFIGS['RADAR'];

  useEffect(() => {
    if (prevAssetType.current !== assetType) {
      dataHistories.current = [Array(30).fill(0), Array(30).fill(0)];
      prevAssetType.current = assetType;
    }

    chartRefs.forEach((ref, idx) => {
      if (ref.current) {
        if (chartInstances.current[idx]) {
          chartInstances.current[idx]?.destroy();
        }

        const ctx = ref.current.getContext('2d')!;
        const grad = ctx.createLinearGradient(0, 0, 0, 100);
        grad.addColorStop(0, 'rgba(34, 211, 238, 0.5)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0.0)');

        const fieldConfig = config.fields[idx];

        chartInstances.current[idx] = new Chart(ctx, {
          type: 'line',
          data: { 
            labels: Array.from({length: 30}, (_, i) => i), 
            datasets: [{ 
              data: dataHistories.current[idx], 
              borderColor: '#22d3ee', 
              backgroundColor: grad, 
              borderWidth: 1.5, 
              fill: true, 
              pointRadius: 0, 
              tension: 0.4 
            }] 
          },
          options: { 
            ...commonOptions, 
            scales: { 
              y: { 
                ...commonOptions.scales?.y, 
                min: fieldConfig.min, 
                max: fieldConfig.max 
              } 
            } 
          }
        });
      }
    });

    return () => {
      chartInstances.current.forEach(chart => chart?.destroy());
    };
  }, [assetType]);

  useEffect(() => {
    config.fields.forEach((fieldConfig: any, idx: number) => {
      const val = telemetry[fieldConfig.key] || 0;
      dataHistories.current[idx].push(val);
      dataHistories.current[idx].shift();

      const isAnomaly = val >= fieldConfig.anomalyThreshold;
      const color = isAnomaly || degraded ? '#f43f5e' : '#22d3ee';

      if (chartInstances.current[idx]) {
        chartInstances.current[idx]!.data.datasets[0].borderColor = color;
        chartInstances.current[idx]!.update();
      }
    });
  }, [telemetry, degraded, assetType]);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-4 flex items-center">
          <Activity className="w-4 h-4 mr-2" /> Prognostics &amp; Telemetry
      </h2>
      
      {config.fields.map((fieldConfig: any, idx: number) => {
        const val = telemetry[fieldConfig.key] || 0;
        const isAnomaly = val >= fieldConfig.anomalyThreshold;
        
        return (
          <div key={fieldConfig.key} className="mb-4">
              <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">{fieldConfig.label}</span>
                  <span className={`font-bold ${isAnomaly || degraded ? 'text-rose-400 glow-rose' : 'text-cyan-400'}`}>
                    {val.toFixed(1)} {fieldConfig.unit}
                  </span>
              </div>
              <div className="h-24 w-full relative">
                  <canvas ref={chartRefs[idx]}></canvas>
              </div>
          </div>
        );
      })}
    </div>
  );
}
