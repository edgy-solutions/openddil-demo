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

// Same-origin by default: nginx.conf's `location /egress/` proxies this
// path to egress-pane-api (compose) / `<release>-egress-pane-api` (Helm),
// same idiom as `/electric/`, and it is BEHIND __SESSION_GATE__ — the pane
// returns per-record release decisions (asset ids, originator nations), the
// same class of data the gate on `location /` protects. Fetching a
// cross-origin host here would both reach the wrong pane on a workstation
// running more than one stack under Docker Desktop and bypass that gate
// entirely, so `/egress` (not `http://localhost:8090`) is the default.
// VITE_EGRESS_PANE_URL remains as an escape hatch for anyone fronting the
// pane a different way.
export const EGRESS_PANE_URL =
  (import.meta.env.VITE_EGRESS_PANE_URL ?? '/egress').replace(/\/$/, '');

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
  /** How many of the pane's records this viewer's nations do not cover —
   *  present only when the PEP filtered this response (gateway/egress_view.py).
   *  Optional because compose's direct, unfiltered pane sends neither this
   *  nor `viewer_nations`. */
  withheld?: number;
  /** The nations the PEP resolved for this viewer (sorted), present under
   *  the same condition as `withheld`. */
  viewer_nations?: string[];
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
          // Either pane_api.py's own outage response (`detail`) or the
          // PEP's relayed one (`cause` — see pep.py's `_deny`, which never
          // writes `detail`). The two surfaces disagree on the field name,
          // not on the meaning, so both are read here rather than picking one.
          const policyUnavailableDetail =
            typeof body.detail === 'string'
              ? body.detail
              : typeof body.cause === 'string'
                ? body.cause
                : null;
          setResult({
            data: null,
            isLoading: false,
            isError: false,
            isPolicyUnavailable: true,
            policyUnavailableDetail,
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
