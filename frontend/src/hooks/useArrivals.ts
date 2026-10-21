// useArrivals -- polls GET /arrivals for one edge (ADR-0050 s3).
// The result is held with the edge it was fetched for, so after an edge
// change the previous edge's rows read as "not loaded" until the new edge
// answers: a stale edge never shows, and no state is reset inside the effect.
// A failed poll keeps serving the last ok result for the same edge (so the
// badge and tab do not vanish) and reports the failure as lastError; the next
// poll after a failure comes sooner (RETRY_MS).
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadArrivals, type LoadArrivalsResult } from '../lib/arrivals';

export const POLL_MS = 10_000;
export const RETRY_MS = 3_000;

interface Held {
  edgeId: string;
  /** What is served: the last ok result when the latest answer was an error. */
  shown: LoadArrivalsResult;
  lastError: string | null;
}

export function useArrivals(edgeId: string | null): {
  state: LoadArrivalsResult | undefined;
  lastError: string | null;
  refetch: () => Promise<void>;
} {
  const [held, setHeld] = useState<Held | null>(null);
  // True while the latest answers are failures: warn once per run of failures.
  const failing = useRef(false);

  const apply = useCallback((id: string, result: LoadArrivalsResult) => {
    if (result.kind === 'error') {
      if (!failing.current) {
        failing.current = true;
        console.warn(`arrivals poll failed for ${id}: ${result.message}`);
      }
      setHeld((prev) => {
        const keep = prev && prev.edgeId === id && prev.shown.kind === 'ok' ? prev.shown : result;
        return { edgeId: id, shown: keep, lastError: result.message };
      });
    } else {
      failing.current = false;
      setHeld({ edgeId: id, shown: result, lastError: null });
    }
  }, []);

  const refetch = useCallback(async () => {
    if (!edgeId) return;
    apply(edgeId, await loadArrivals(edgeId));
  }, [edgeId, apply]);

  useEffect(() => {
    if (!edgeId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    failing.current = false;
    const tick = () => {
      loadArrivals(edgeId).then((result) => {
        if (cancelled) return;
        apply(edgeId, result);
        timer = setTimeout(tick, result.kind === 'error' ? RETRY_MS : POLL_MS);
      });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [edgeId, apply]);

  const mine = held && held.edgeId === edgeId ? held : null;
  return { state: mine?.shown, lastError: mine?.lastError ?? null, refetch };
}
