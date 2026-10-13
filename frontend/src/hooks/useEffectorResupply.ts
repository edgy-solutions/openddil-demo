// useEffectorResupply -- rounds received by launchers (append-only).
// Source: effector_resupply, filtered by launcher_asset_id.
import { num, parseTextArray, useTableShape, sqlLiteral, type ShapeResult } from './electric';

export interface EffectorResupply {
  eventUrn: string;
  launcherAssetId: string;
  supplierAssetId: string | null;
  /** DIS munition 7-tuple, as stored. */
  munitionType: string;
  quantity: number;
  receivedAt: string;
  edgeId: string | null;
  regionId: string | null;
  /** Releasability labels as stored (ADR-0029); null when unlabelled. */
  originatorNation: string | null;
  releasableTo: string[] | null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function nullableStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function mapEffectorResupply(row: Record<string, unknown>): EffectorResupply {
  return {
    eventUrn: str(row.event_urn),
    launcherAssetId: str(row.launcher_asset_id),
    supplierAssetId: nullableStr(row.supplier_asset_id),
    munitionType: str(row.munition_type),
    quantity: num(row.quantity),
    receivedAt: str(row.received_at),
    edgeId: nullableStr(row.edge_id),
    regionId: nullableStr(row.region_id),
    originatorNation: row.originator_nation == null || row.originator_nation === '' ? null : String(row.originator_nation),
    releasableTo: parseTextArray(row.releasable_to),
  };
}

/** Resupplies received by any of the given launcher assets. */
export function useEffectorResupply(launcherAssetIds: string[]): ShapeResult<EffectorResupply> {
  const ids = [...new Set(launcherAssetIds)].sort();
  return useTableShape('effector_resupply', mapEffectorResupply, {
    where: `launcher_asset_id IN (${(ids.length ? ids : ['']).map(sqlLiteral).join(', ')})`,
  });
}
