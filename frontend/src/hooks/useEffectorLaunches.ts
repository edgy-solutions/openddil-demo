// useEffectorLaunches — effector (munition) launches fired by one launcher.
// Source: effector_launch, filtered by launcher_asset_id.
//
// One row per Fire/Detonation event_urn (DIS path): a Fire inserts the row
// in flight, a matching Detonation closes it with a terminal_state from the
// small vocabulary the schema's CHECK constraint carries -- never "miss",
// because absence of a detonation is not an outcome. terminal_state NULL
// means still in flight; 'unresolved' means the timeout swept it with no
// Detonation seen.
//
// Declared load / remaining-of-declared is deliberately NOT read here --
// how declared load reaches the browser is still an open decision, and
// effector_declared_load / effector_launcher_counts are not published to
// Electric.
import { num, useTableShape, sqlLiteral, type ShapeResult } from './electric';

export interface EffectorLaunch {
  eventUrn: string;
  /** DIS munition 7-tuple, stored and returned as-is (e.g. "1.2.3.4.5.6.7"). */
  munitionType: string;
  quantity: number;
  targetAssetId: string | null;
  launchedAt: string;
  /** null = in flight. Otherwise one of the schema's terminal vocabulary,
   *  including 'unresolved' (timeout swept it, no Detonation seen). */
  terminalState: string | null;
  /** Raw DIS detonationResult enum, carried alongside terminalState. */
  detonationResult: number | null;
  terminatedAt: string | null;
  /** true when a real Detonation resolved a row the timeout sweep had
   *  already marked 'unresolved'. */
  lateTerminal: boolean;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function nullableStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function nullableNum(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : num(v);
}

// Exported for direct unit testing of the row mapping, same reasoning as
// the component-level pure helpers in EffectorTracksCard.tsx.
export function mapEffectorLaunch(row: Record<string, unknown>): EffectorLaunch {
  return {
    eventUrn: str(row.event_urn),
    munitionType: str(row.munition_type),
    quantity: num(row.quantity),
    targetAssetId: nullableStr(row.target_asset_id),
    launchedAt: str(row.launched_at),
    terminalState: nullableStr(row.terminal_state),
    detonationResult: nullableNum(row.detonation_result),
    terminatedAt: nullableStr(row.terminated_at),
    // Electric returns booleans as the literal strings "t"/"f".
    lateTerminal: row.late_terminal === true || row.late_terminal === 't',
  };
}

/** Effector launches fired by one launcher asset. */
export function useEffectorLaunches(launcherAssetId: string): ShapeResult<EffectorLaunch> {
  return useTableShape('effector_launch', mapEffectorLaunch, {
    where: `launcher_asset_id = ${sqlLiteral(launcherAssetId)}`,
  });
}

/** One launch row's join keys: which munition entity a Fire produced and
 *  which launcher fired it. */
export interface MunitionLaunch {
  munition_asset_id: string | null;
  launcher_asset_id: string;
  event_urn: string;
}

export function mapMunitionLaunch(row: Record<string, unknown>): MunitionLaunch {
  return {
    munition_asset_id: nullableStr(row.munition_asset_id),
    launcher_asset_id: str(row.launcher_asset_id),
    event_urn: str(row.event_urn),
  };
}

/** Every launch that declares its munition entity, for attributing
 *  in-flight munitions to their launcher. */
export function useMunitionLaunches(): ShapeResult<MunitionLaunch> {
  return useTableShape('effector_launch', mapMunitionLaunch, {
    where: 'munition_asset_id IS NOT NULL',
  });
}
