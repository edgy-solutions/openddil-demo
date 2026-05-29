// ElectricSQL shape hooks — the single read path for pipeline state.
// Each hook subscribes to one projector-populated Postgres table.
export { ELECTRIC_URL, num, type ShapeResult } from './electric';
export {
  useFleetAssets,
  useFleetAssetsForRegion,
  useFleetAssetsForEdge,
  type FleetAsset,
} from './useFleetAssets';
export {
  useTelemetryLatest,
  type TelemetryLatest,
  type OperationalState,
  type Quantity,
} from './useTelemetryLatest';
export { useCmState, useAllCmState, type CmState } from './useCmState';
export {
  useLogisticsStatus,
  useAllLogisticsStatus,
  type LogisticsStatus,
  type ConstrainingFactor,
} from './useLogisticsStatus';
export {
  useTelemetryWindows,
  useAllTelemetryWindows,
  type TelemetryWindows,
} from './useTelemetryWindows';
export { useTacticalEvents, type TacticalEvent } from './useTacticalEvents';
export {
  useEdgeBuffer,
  type EdgeBufferStatus,
  type EdgeBufferResult,
} from './useEdgeBuffer';
export {
  useRegionFleetSummary,
  type RegionFleetSummary,
} from './useRegionFleetSummary';
export {
  useRegionTopFactors,
  type RegionTopFactors,
  type RegionFactor,
} from './useRegionTopFactors';
export {
  useRegionWearTrends,
  type RegionWearTrends,
  type ComponentWearTrend,
} from './useRegionWearTrends';
