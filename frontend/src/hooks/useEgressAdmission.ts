// =============================================================================
// useEgressAdmission — what the egress gate decided, read back for display
// =============================================================================
// This is NOT an Electric shape hook like the others in this directory. The
// gate's decisions are not a Postgres-projected table on the compacted
// asset-logistics-status stream; they are computed on request by
// `egress/pane_api.py`, which calls the exact same `EgressGate.decide` path
// `egress/main.py` calls for the real wire. A plain fetch against that
// endpoint is the only way to ask "what would the gate say right now" without
// re-deciding anything here — see the endpoint's own module docstring for why
// a second, independent HTTP surface exists at all.
//
// NOTHING IN THIS FILE DECIDES ADMISSION. It transports `allowed` and
// `reason` from the endpoint to the component unchanged. See
// `useFleetAssets.ts` for the standing rule this follows: a second filter
// here would be a second authorization decision nobody reviewed (ADR-0029
// §1). There is no `.filter()` on nation in this file, and there must never
// be one.
import { useEffect, useState } from 'react';

// Compose publishes the pane API on its own host port; there is no
// same-origin proxy for it the way Helm mode proxies `/electric/` (see
// nginx.conf). A relative override is still honoured if one is ever fronted
// with a proxy, since `fetch` resolves a relative path against the page's
// own origin without any extra work here.
export const EGRESS_PANE_URL =
  (import.meta.env.VITE_EGRESS_PANE_URL ?? 'http://localhost:8090').replace(/\/$/, '');

export interface DecisionRecord {
  asset_id: string;
  originator_nation: string | null;
  releasable_to: string[];
  allowed: boolean;
  /** null on admit — `allowed` already says so. One of gate.py's REASON_*
   *  constants when refused; rendered verbatim, never matched against here. */
  reason: string | null;
  decision_id: string;
}

export interface DecisionsResponse {
  destination: string;
  policy_version: string;
  corpus_version: string;
  admitted: number;
  refused: number;
  records: DecisionRecord[];
}

export interface EgressAdmissionResult {
  data: DecisionsResponse | null;
  isLoading: boolean;
  isError: boolean;
  /** The PDP could not be reached — REASON_AUTHZ_UNAVAILABLE at the gate.
   *  Distinct from `isError` (a transport/endpoint problem) and distinct
   *  from "0 admitted": an outage is not a denial, and collapsing the two
   *  states would be the pane lying about policy. */
  isPolicyUnavailable: boolean;
  policyUnavailableDetail: string | null;
}

const INITIAL: EgressAdmissionResult = {
  data: null,
  isLoading: true,
  isError: false,
  isPolicyUnavailable: false,
  policyUnavailableDetail: null,
};

export function useEgressAdmission(destination: string): EgressAdmissionResult {
  const [result, setResult] = useState<EgressAdmissionResult>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    setResult((prev) => ({ ...prev, isLoading: true, isError: false }));

    const url = `${EGRESS_PANE_URL}/decisions?destination=${encodeURIComponent(destination)}`;
    fetch(url)
      .then(async (res) => {
        if (cancelled) return;
        const body = await res.json().catch(() => null);

        if (res.status === 503 && body?.error) {
          // pane_api.py's outage response — see its do_GET handler.
          setResult({
            data: null,
            isLoading: false,
            isError: false,
            isPolicyUnavailable: true,
            policyUnavailableDetail: typeof body.detail === 'string' ? body.detail : null,
          });
          return;
        }
        if (!res.ok || !body) {
          setResult({ ...INITIAL, isLoading: false, isError: true });
          return;
        }
        setResult({
          data: body as DecisionsResponse,
          isLoading: false,
          isError: false,
          isPolicyUnavailable: false,
          policyUnavailableDetail: null,
        });
      })
      .catch(() => {
        if (!cancelled) setResult({ ...INITIAL, isLoading: false, isError: true });
      });

    return () => {
      cancelled = true;
    };
  }, [destination]);

  return result;
}
