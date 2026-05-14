// =============================================================================
// Platform-variant -> telemetry chart config (Phase 4b)
// =============================================================================
// Replaces the old asset-TYPE-keyed ASSET_CONFIGS. The pipeline emits
// `platform_variant` (e.g. "M1A2-SEPv3"), not the coarse RADAR/ARTILLERY
// classes the mock simulator used. Each variant declares which
// `sustainment.*` Quantity paths its telemetry charts plot.
//
// Adding a platform is a config edit here, not a code change in
// TelemetryCharts. Kept as a TypeScript constant rather than a YAML file
// so there's no runtime YAML loader in the Vite bundle.
//
// NOTE: the OSS DIS feed carries kinematics only — no sustainment metrics.
// Charts for a DIS-sourced asset render their empty state until a
// sustainment-bearing feed (sim-a / proprietary) drives the asset.
// =============================================================================

export interface ChartField {
  /** dot-path into the telemetry `sustainment` jsonb, e.g. "thermal.component_temperature". */
  path: string;
  label: string;
  /** anomaly threshold on the Quantity value; charted line turns red at/above. */
  anomalyThreshold?: number;
}

export interface PlatformChartConfig {
  /** coarse class for 3D-view routing (LtamdsView vs DiagnosticCanvas). */
  assetClass: 'RADAR' | 'GROUND' | 'AIR' | 'UGV' | 'UNKNOWN';
  fields: ChartField[];
}

export const PLATFORM_CHART_CONFIGS: Record<string, PlatformChartConfig> = {
  'M1A2-SEPv3': {
    assetClass: 'GROUND',
    fields: [
      { path: 'thermal.component_temperature', label: 'Powerpack Thermal', anomalyThreshold: 120 },
      { path: 'fluids.fuel_remaining', label: 'Fuel Remaining' },
    ],
  },
  'AH-64E-V6': {
    assetClass: 'AIR',
    fields: [
      { path: 'thermal.component_temperature', label: 'Engine Thermal', anomalyThreshold: 150 },
      { path: 'power.bus_voltage', label: 'Bus Voltage' },
      { path: 'fluids.fuel_remaining', label: 'Fuel Remaining' },
    ],
  },
  'LTAMDS': {
    assetClass: 'RADAR',
    fields: [
      { path: 'thermal.component_temperature', label: 'Array Thermal Matrix', anomalyThreshold: 85 },
      { path: 'thermal.coolant_temperature', label: 'Coolant Temperature' },
    ],
  },
  DEFAULT: {
    assetClass: 'UNKNOWN',
    fields: [
      { path: 'thermal.component_temperature', label: 'Component Temperature' },
      { path: 'fluids.fuel_remaining', label: 'Fuel Remaining' },
    ],
  },
};

/** Resolve a platform_variant to its chart config, DEFAULT if unknown. */
export function platformChartConfig(variant: string | null | undefined): PlatformChartConfig {
  if (variant && PLATFORM_CHART_CONFIGS[variant]) return PLATFORM_CHART_CONFIGS[variant];
  // RADAR-class match by substring so "LTAMDS-04" etc. still route to radar.
  if (variant && /LTAMDS|RADAR|SENTINEL/i.test(variant)) return PLATFORM_CHART_CONFIGS['LTAMDS'];
  return PLATFORM_CHART_CONFIGS.DEFAULT;
}

/** Coarse class for 3D-view routing. */
export function platformClass(variant: string | null | undefined): PlatformChartConfig['assetClass'] {
  return platformChartConfig(variant).assetClass;
}
