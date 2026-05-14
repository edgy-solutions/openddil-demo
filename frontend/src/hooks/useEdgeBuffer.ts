// useEdgeBuffer — real edge->HQ DDIL link/buffer status (Phase 4c.5).
// Source: edge_buffer_status (singleton row id='edge'), written by the
// openddil-projector's edge-buffer monitor.
//
// bridge_group_lag is the genuine edge-buffer depth — the `bridge-group`
// consumer-group lag on redpanda-edge. It climbs when the hq-link is
// severed (the edge-hq-bridge can't drain) and falls when it's restored.
// Replaces the client-side setBuffer simulations that presented synthetic
// numbers as real.
import { num, useTableShape, type ShapeResult } from './electric';

export interface EdgeBufferStatus {
  bridge_group_lag: number;
  hq_link_severed: boolean;
  probe_healthy: boolean;
  updated_at: string | null;
}

function mapEdgeBuffer(row: Record<string, any>): EdgeBufferStatus {
  return {
    bridge_group_lag: num(row.bridge_group_lag),
    // Electric returns booleans as the literal strings "t"/"f".
    hq_link_severed: row.hq_link_severed === true || row.hq_link_severed === 't',
    probe_healthy: row.probe_healthy === true || row.probe_healthy === 't',
    updated_at: row.updated_at ?? null,
  };
}

export interface EdgeBufferResult {
  status: EdgeBufferStatus | null;
  isLoading: boolean;
  isError: boolean;
}

/** The edge->HQ link/buffer status. `status` is null until the first sync. */
export function useEdgeBuffer(): EdgeBufferResult {
  const result: ShapeResult<EdgeBufferStatus> = useTableShape(
    'edge_buffer_status',
    mapEdgeBuffer,
  );
  return {
    status: result.data[0] ?? null,
    isLoading: result.isLoading,
    isError: result.isError,
  };
}
