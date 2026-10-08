// Whether an asset row is a site's sensor record is a declared field on the
// row (telemetry_latest_state.subsystem), set by the boundary mapper. The
// asset_id is opaque and never inspected for it. A null subsystem means the
// row is the platform itself.
export const SENSOR_SUBSYSTEM = 'ASSET_SUBSYSTEM_SENSOR';

export function isDeclaredSensor(subsystem: string | null | undefined): boolean {
  return subsystem === SENSOR_SUBSYSTEM;
}
