// useArrivalsSummary -- polls GET /arrivals/summary (per-edge counts).
// `result` stays null until the first answer; ok, absent and error all count
// as an answer, so callers can tell "not asked yet" from "asked, nothing".
import { useEffect, useState } from 'react';
import { loadArrivalsSummary, type LoadArrivalsSummaryResult } from '../lib/arrivals';

const REFRESH_MS = 15_000;

export function useArrivalsSummary(): LoadArrivalsSummaryResult | null {
  const [result, setResult] = useState<LoadArrivalsSummaryResult | null>(null);

  useEffect(() => {
    let live = true;
    const tick = () => {
      void loadArrivalsSummary().then((r) => {
        if (live) setResult(r);
      });
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return result;
}
