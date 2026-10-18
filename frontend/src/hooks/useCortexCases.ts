// =============================================================================
// useCortexCases — the cases cortex holds for one asset
// =============================================================================
// GET <egress base>/cases?asset_id=<id> returns the door's delivery rows:
// {cases: [{route, case_id, episode_id, event_id, asset_id, component,
// fault_code, delivered_at}]}. A case exists in cortex only after delivery,
// so an empty list is normal. Fetched once on open and every 15 s while
// mounted, and ONLY when cortex is configured (no cortex => no fetch).
// A failure draws nothing; one console.warn per failure streak.
import { useEffect, useState } from 'react';
import { cortexBaseUrl } from '../deployment';
import { EGRESS_PANE_URL } from './useEgressAdmission';

export interface CortexCase {
  case_id: string;
  component?: string | null;
  fault_code?: string | null;
  delivered_at?: string | null;
}

export const CORTEX_CASES_POLL_MS = 15_000;

/** The newest-delivered case matching a fault: fault_code equal, and
 *  component equal when both sides carry one. */
export function matchCase(
  cases: CortexCase[],
  fault: { faultCode: string; component?: string | null },
): CortexCase | null {
  let best: CortexCase | null = null;
  for (const c of cases) {
    if (!c || typeof c.case_id !== 'string' || c.case_id === '') continue;
    if (c.fault_code !== fault.faultCode) continue;
    if (c.component && fault.component && c.component !== fault.component) continue;
    if (!best || (c.delivered_at ?? '') > (best.delivered_at ?? '')) best = c;
  }
  return best;
}

export function useCortexCases(assetId: string | null | undefined): CortexCase[] {
  const [cases, setCases] = useState<CortexCase[]>([]);
  const configured = cortexBaseUrl() !== undefined;

  useEffect(() => {
    if (!configured || !assetId) return;
    let cancelled = false;
    let failing = false;
    const load = async () => {
      try {
        const res = await fetch(`${EGRESS_PANE_URL}/cases?asset_id=${encodeURIComponent(assetId)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        failing = false;
        setCases(Array.isArray(body?.cases) ? body.cases : []);
      } catch (err) {
        if (cancelled) return;
        setCases([]);
        if (!failing) {
          failing = true;
          console.warn('[cortex] cases fetch failed:', err);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), CORTEX_CASES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [configured, assetId]);

  return configured && assetId ? cases : [];
}
