// useArrivals -- polls GET /arrivals for one edge (ADR-0050 s3).
// The result is held with the edge it was fetched for, so after an edge
// change the previous edge's rows read as "not loaded" until the new edge
// answers: a stale edge never shows, and no state is reset inside the effect.
import { useCallback, useEffect, useState } from 'react';
import { loadArrivals, type LoadArrivalsResult } from '../lib/arrivals';

const POLL_MS = 10_000;

export function useArrivals(edgeId: string | null): {
  state: LoadArrivalsResult | undefined;
  refetch: () => Promise<void>;
} {
  const [held, setHeld] = useState<{ edgeId: string; result: LoadArrivalsResult } | null>(null);

  const refetch = useCallback(async () => {
    if (!edgeId) return;
    const result = await loadArrivals(edgeId);
    setHeld({ edgeId, result });
  }, [edgeId]);

  useEffect(() => {
    if (!edgeId) return;
    let cancelled = false;
    const tick = () =>
      loadArrivals(edgeId).then((result) => {
        if (!cancelled) setHeld({ edgeId, result });
      });
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [edgeId]);

  return { state: held && held.edgeId === edgeId ? held.result : undefined, refetch };
}
