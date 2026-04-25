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
  thermal: number;
  pressure: number;
  degraded: boolean;
}

export default function TelemetryCharts({ thermal, pressure, degraded }: TelemetryChartsProps) {
  const thermalRef = useRef<HTMLCanvasElement>(null);
  const pressureRef = useRef<HTMLCanvasElement>(null);
  const chartInstances = useRef<{ thermal?: Chart, pressure?: Chart }>({});
  
  const thermalData = useRef<number[]>(Array(30).fill(32));
  const pressureData = useRef<number[]>(Array(30).fill(120));

  useEffect(() => {
    if (thermalRef.current && pressureRef.current) {
      const ctxThermal = thermalRef.current.getContext('2d')!;
      const gradThermal = ctxThermal.createLinearGradient(0, 0, 0, 100);
      gradThermal.addColorStop(0, 'rgba(245, 158, 11, 0.5)');
      gradThermal.addColorStop(1, 'rgba(245, 158, 11, 0.0)');

      chartInstances.current.thermal = new Chart(ctxThermal, {
        type: 'line',
        data: { labels: Array.from({length: 30}, (_, i) => i), datasets: [{ data: thermalData.current, borderColor: '#f59e0b', backgroundColor: gradThermal, borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.4 }] },
        options: { ...commonOptions, scales: { y: { ...commonOptions.scales?.y, min: 20, max: 60 } } }
      });

      const ctxPressure = pressureRef.current.getContext('2d')!;
      const gradPressure = ctxPressure.createLinearGradient(0, 0, 0, 100);
      gradPressure.addColorStop(0, 'rgba(16, 185, 129, 0.5)');
      gradPressure.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

      chartInstances.current.pressure = new Chart(ctxPressure, {
        type: 'line',
        data: { labels: Array.from({length: 30}, (_, i) => i), datasets: [{ data: pressureData.current, borderColor: '#10b981', backgroundColor: gradPressure, borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.4 }] },
        options: { ...commonOptions, scales: { y: { ...commonOptions.scales?.y, min: 0, max: 150 } } }
      });
    }

    return () => {
      chartInstances.current.thermal?.destroy();
      chartInstances.current.pressure?.destroy();
    };
  }, []);

  useEffect(() => {
    thermalData.current.push(thermal);
    thermalData.current.shift();
    pressureData.current.push(pressure);
    pressureData.current.shift();

    if (chartInstances.current.thermal) {
      chartInstances.current.thermal.data.datasets[0].borderColor = degraded ? '#f43f5e' : '#f59e0b';
      chartInstances.current.thermal.update();
    }
    if (chartInstances.current.pressure) {
      chartInstances.current.pressure.data.datasets[0].borderColor = degraded ? '#f43f5e' : '#10b981';
      chartInstances.current.pressure.update();
    }
  }, [thermal, pressure, degraded]);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-4 flex items-center">
          <Activity className="w-4 h-4 mr-2" /> Prognostics &amp; Telemetry
      </h2>
      
      <div className="mb-4">
          <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-300">Primary Array Thermal Matrix</span>
              <span className={`font-bold ${thermal > 45 ? 'text-rose-400 glow-rose' : 'text-amber-400'}`}>{thermal.toFixed(1)}°C</span>
          </div>
          <div className="h-24 w-full relative">
              <canvas ref={thermalRef}></canvas>
          </div>
      </div>

      <div>
          <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-300">Coolant Manifold Pressure</span>
              <span className={`font-bold ${pressure < 80 ? 'text-rose-400 glow-rose' : 'text-emerald-400'}`}>{pressure.toFixed(1)} PSI</span>
          </div>
          <div className="h-24 w-full relative">
              <canvas ref={pressureRef}></canvas>
          </div>
      </div>
    </div>
  );
}