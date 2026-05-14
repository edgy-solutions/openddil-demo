// ElectricSQL shape hooks — the single read path for pipeline state.
// Each hook subscribes to one projector-populated Postgres table.
export { ELECTRIC_URL, num, type ShapeResult } from './electric';
export { useFleetAssets, type FleetAsset } from './useFleetAssets';
export {
  useTelemetryLatest,
  type TelemetryLatest,
  type Quantity,
} from './useTelemetryLatest';
export { useCmState, type CmState } from './useCmState';
export {
  useLogisticsStatus,
  type LogisticsStatus,
  type ConstrainingFactor,
} from './useLogisticsStatus';
export {
  useTelemetryWindows,
  type TelemetryWindows,
} from './useTelemetryWindows';
export { useTacticalEvents, type TacticalEvent } from './useTacticalEvents';
