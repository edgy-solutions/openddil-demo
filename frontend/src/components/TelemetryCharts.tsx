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

interface TelemetryChartsProps {
  assetType: string;
  telemetry: any;
  degraded: boolean;
}

const CONFIG = {
  'RADAR': [
    { key: 'core_temp', label: 'Primary Array Thermal Matrix', unit: '°C', min: 20, max: 60, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.5)', threshold: 45, isHighBad: true },
    { key: 'coolant_pressure', label: 'Coolant Manifold Pressure', unit: ' PSI', min: 0, max: 150, color: '#10b981', bg: 'rgba(16, 185, 129, 0.5)', threshold: 80, isHighBad: false }
  ],
  'LASER_SHORAD': [
    { key: 'cavity_temp', label: 'Laser Cavity Temperature', unit: '°C', min: 50, max: 150, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.5)', threshold: 100, isHighBad: true },
    { key: 'pump_rpm', label: 'Coolant Pump RPM', unit: ' RPM', min: 0, max: 6000, color: '#10b981', bg: 'rgba(16, 185, 129, 0.5)', threshold: 2000, isHighBad: false }
  ],
  'ARTILLERY': [
    { key: 'hydraulic_pressure', label: 'Hydraulic Actuator Pressure', unit: ' PSI', min: 0, max: 4000, color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.5)', threshold: 1000, isHighBad: false },
    { key: 'elevation_angle', label: 'Pod Elevation Angle', unit: '°', min: 0, max: 90, color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.5)', threshold: 90, isHighBad: true }
  ],
  'QUADRUPED': [
    { key: 'joint_torque', label: 'Leg Joint Torque', unit: ' Nm', min: 0, max: 50, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.5)', threshold: 30, isHighBad: true },
    { key: 'battery_discharge', label: 'Battery Discharge Rate', unit: ' A', min: 0, max: 30, color: '#10b981', bg: 'rgba(16, 185, 129, 0.5)', threshold: 15, isHighBad: true }
  ]
};

function ChartWidget({ config, value, degraded }: { config: any, value: number, degraded: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const dataRef = useRef<number[]>(Array(30).fill(value || (config.min + config.max)/2));

  useEffect(() => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d')!;
      const grad = ctx.createLinearGradient(0, 0, 0, 100);
      grad.addColorStop(0, config.bg);
      grad.addColorStop(1, config.bg.replace('0.5)', '0.0)'));

      chartRef.current = new Chart(ctx, {
        type: 'line',
        data: { labels: Array.from({length: 30}, (_, i) => i), datasets: [{ data: dataRef.current, borderColor: config.color, backgroundColor: grad, borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.4 }] },
        options: { ...commonOptions, scales: { y: { ...commonOptions.scales?.y, min: config.min, max: config.max } } }
      });
    }
    return () => chartRef.current?.destroy();
  }, [config]);

  useEffect(() => {
    if (value !== undefined) {
      dataRef.current.push(value);
      dataRef.current.shift();
      if (chartRef.current) {
        chartRef.current.data.datasets[0].borderColor = degraded ? '#f43f5e' : config.color;
        chartRef.current.update();
      }
    }
  }, [value, degraded, config]);

  const isAnomalous = config.isHighBad ? value > config.threshold : value < config.threshold;
  const valColor = isAnomalous ? 'text-rose-400 glow-rose' : 'text-emerald-400';

  return (
      <div className="mb-4">
          <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-300">{config.label}</span>
              <span className={`font-bold ${valColor}`}>{(value || 0).toFixed(1)}{config.unit}</span>
          </div>
          <div className="h-24 w-full relative">
              <canvas ref={canvasRef}></canvas>
          </div>
      </div>
  );
}

export default function TelemetryCharts({ assetType, telemetry, degraded }: TelemetryChartsProps) {
  const configs = CONFIG[assetType as keyof typeof CONFIG] || CONFIG['RADAR'];

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-4 flex items-center">
          <Activity className="w-4 h-4 mr-2" /> Prognostics &amp; Telemetry
      </h2>
      
      {configs.map(config => (
        <ChartWidget key={config.key} config={config} value={telemetry[config.key]} degraded={degraded} />
      ))}
    </div>
  );
}
