// useTacticalEvents — recent tactical events (CloudEvents) across all assets.
// Source: tactical_events (append-only, projector-pruned to 24h).
//
// Electric Shapes don't expose a simple ORDER BY / LIMIT, so the hook
// subscribes to the whole (24h-bounded) shape and sorts by `time`
// descending + slices client-side. The 24h projector retention keeps the
// shape small enough that this is cheap.
import { useMemo } from 'react';
import { useTableShape, type ShapeResult } from './electric';

export interface TacticalEvent {
  id: string;
  source: string;
  type: string;
  /** asset_id the event concerns. */
  subject: string;
  /** best-effort severity extracted from the CloudEvent data. */
  severity: string | null;
  time: string;
  /** the CloudEvent `data` payload. */
  data: Record<string, any>;
}

function mapEvent(row: Record<string, any>): TacticalEvent {
  return {
    id: row.id,
    source: row.source ?? '',
    type: row.type ?? '',
    subject: row.subject ?? '',
    severity: row.severity ?? null,
    time: row.time ?? '',
    data: row.data ?? {},
  };
}

/**
 * Recent tactical events, newest first, capped at `limit`. Optionally
 * filtered to one asset via `subject`.
 */
export function useTacticalEvents(
  limit = 100,
  subject?: string,
): ShapeResult<TacticalEvent> {
  const result = useTableShape('tactical_events', mapEvent);

  const data = useMemo(() => {
    let rows = result.data;
    if (subject) rows = rows.filter((e) => e.subject === subject);
    return [...rows]
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
      .slice(0, limit);
  }, [result.data, limit, subject]);

  return { ...result, data };
}
