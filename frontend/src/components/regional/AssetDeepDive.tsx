// =============================================================================
// AssetDeepDive — regional per-asset detail panel
// =============================================================================
// Phase 4c rewrite. Was hardcoded MTBF / simulated burn rates / a static
// maintenance-log table. Now shows real pipeline data for the
// regionally-selected asset: CM state, logistics status, and sustainment
// telemetry — the same cards the maintainer view uses, scoped to one
// asset. Opened when an asset is picked in the AOR list or the 3D map.
import { X } from 'lucide-react';
import CmStateCard from '../CmStateCard';
import LogisticsStatusCard from '../LogisticsStatusCard';
import EffectorTracksCard from '../EffectorTracksCard';
import TelemetryCharts from '../TelemetryCharts';
import {
  useCmState,
  useLogisticsStatus,
  useTelemetryLatest,
  useTelemetryWindows,
  useEffectorLaunches,
  useAssetElementTelemetry,
} from '../../hooks';

interface AssetDeepDiveProps {
  assetId: string;
  onClose: () => void;
}

export default function AssetDeepDive({ assetId, onClose }: AssetDeepDiveProps) {
  const cm = useCmState(assetId);
  const logistics = useLogisticsStatus(assetId);
  const telemetry = useTelemetryLatest(assetId);
  const telemetryWindows = useTelemetryWindows(assetId);
  const effectorLaunches = useEffectorLaunches(assetId);
  const elementTelemetry = useAssetElementTelemetry(assetId);

  const tel = telemetry.data[0] ?? null;
  const variant = tel?.platform_variant ?? null;
  const rollupRow = telemetryWindows.data[0] ?? null;
  // Same wire power signal the edge asset view uses: a powered-off asset
  // must not stream its last rollup as if live.
  const wirePower = tel?.operational_state?.power_state;
  const isPoweredOff =
    wirePower === 'POWER_STATE_OFF' || wirePower === 'POWER_STATE_SHUTTING_DOWN';

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-2 pb-2">
      <div className="panel p-4 flex justify-between items-center bg-slate-900 border-emerald-500 border-l-4 shrink-0">
        <div>
          <h2 className="text-emerald-400 font-bold text-lg">
            {tel?.callsign || assetId}
          </h2>
          <p className="text-slate-400 text-xs font-mono tracking-widest">
            {variant ?? 'unknown variant'} // DEEP DIVE
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white bg-slate-800 px-3 py-1 text-xs border border-slate-700 flex items-center gap-1"
        >
          <X className="w-3 h-3" /> CLOSE
        </button>
      </div>

      {/* isLoading threaded so the panels show a syncing state on cold
          start rather than flashing the genuinely-empty copy. */}
      <CmStateCard cm={cm.data[0] ?? null} isLoading={cm.isLoading} />
      <LogisticsStatusCard logistics={logistics.data[0] ?? null} isLoading={logistics.isLoading} />
      <EffectorTracksCard launches={effectorLaunches.data} />
      <TelemetryCharts
        telemetry={tel}
        platformVariant={variant}
        degraded={false}
        isLoading={telemetry.isLoading}
        liveTelemetry={elementTelemetry.liveTelemetry}
        assetId={assetId}
        isPoweredOff={isPoweredOff}
        elementRollup={rollupRow?.element_rollup ?? null}
        rollupEdgeId={rollupRow?.edge_id ?? null}
        condition={elementTelemetry.operational?.condition ?? null}
      />
    </div>
  );
}
