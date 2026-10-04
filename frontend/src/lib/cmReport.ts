// =============================================================================
// cmReport — fault-report submission + fault-code loading
// =============================================================================
// Pure functions backing the "Report a fault" form: load the server's fault
// code list, build and submit a discrepancy report. Kept dependency-free
// (fetchFn injected) so this is testable in vitest's node environment with
// no DOM.
//
// Server contract (built in parallel by the gateway/PEP side):
//   GET  /cm/fault-codes?asset_id=<id>  ->
//     200 {asset_id, platform_variant, manual, codes: [{code, text, component, severity}]}
//     | 400 (no asset_id) | 401 | 404 (off, or asset not visible)
//   POST /cm/discrepancy  -> 202 {event_id} | 400/401/403/404/413/415/502/503
//
// GET is asset-scoped, not a global list: the server resolves the asset's
// platform_variant and returns only that variant's fault-isolation codes
// (gateway/pep.py's FAULT_CATALOG, built from the manual by
// tools/fault_catalog). There is no "all codes" response any more -- a code
// that belongs to a different variant can never appear in what this module
// loads for a given asset. `codes` is empty (not an error) when the variant
// has no fault-isolation module; the caller then offers only "Not listed".
//
// THE CLIENT NEVER SENDS A REPORTER. The PEP stamps the reporter from the
// session; buildReportBody emits exactly four keys (asset_id, component,
// fault_code, description) so an input object carrying extra fields (e.g. a
// caller that still has a stale reported_by/source lying around) can never
// leak one onto the wire.
import type { CmState } from '../hooks';

export type CatalogCode = {
  code: string;
  text: string;
  component: string;
  severity: string;
};

export type FaultCatalog = {
  asset_id: string;
  platform_variant: string | null;
  manual: string | null;
  codes: CatalogCode[];
};

export interface ReportInput {
  assetId: string;
  component: string;
  faultCode: string;
  description: string;
}

const DISCREPANCY_URL = '/cm/discrepancy';
const FAULT_CODES_URL = '/cm/fault-codes';
const MAX_DESCRIPTION_LENGTH = 500;

/** The asset-scoped fault catalog for the "Report a fault" form. null means
 *  the feature is off (not configured on this tier, no session, or the
 *  asset isn't visible to this viewer) — the caller hides the form rather
 *  than showing an error for any of those cases. A non-null result with an
 *  empty `codes` array means the feature IS on but this asset's variant has
 *  no fault-isolation module — that's a real, renderable state (see
 *  noFaultIsolationMessage), not an error. */
export async function loadFaultCatalog(
  assetId: string,
  fetchFn: typeof fetch = fetch,
): Promise<FaultCatalog | null> {
  let res: Response;
  try {
    res = await fetchFn(`${FAULT_CODES_URL}?asset_id=${encodeURIComponent(assetId)}`, {
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
  if (res.status === 404 || res.status === 401 || !res.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || !Array.isArray((body as FaultCatalog).codes)) {
    return null;
  }
  return body as FaultCatalog;
}

/** Fault-code options for the chosen component. component === '' (no
 *  component chosen yet, or the user is picking a code first — "choosing
 *  code sets component") returns every code in the catalog; otherwise only
 *  the codes whose own `component` matches. Never returns a code for a
 *  component other than the one asked for, so a stale/unfiltered upstream
 *  list could never surface here even if one existed. */
export function codeOptionsFor(codes: CatalogCode[], component: string): CatalogCode[] {
  if (!component) return codes;
  return codes.filter((c) => c.component === component);
}

/** Copy for the fault-code field when the asset's variant has no
 *  fault-isolation module (codes: []) — the only remaining option is "Not
 *  listed", and the operator still describes the fault in free text. */
export function noFaultIsolationMessage(platformVariant: string | null): string {
  const variant = platformVariant ?? 'this asset';
  return `No fault-isolation module for ${variant}; describe the fault`;
}

/** The exact JSON body POSTed to /cm/discrepancy — exactly four keys, no
 *  more, regardless of what the caller's input object happens to carry.
 *  Throws on an empty/whitespace or over-length description so a bad
 *  report never reaches fetch. */
export function buildReportBody(input: ReportInput): string {
  const description = input.description.trim();
  if (!description) {
    throw new Error('description must not be empty');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
  }
  const body = {
    asset_id: input.assetId,
    component: input.component,
    fault_code: input.faultCode,
    description,
  };
  return JSON.stringify(body);
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.message === 'string') return b.message;
      if (typeof b.error === 'string') return b.error;
      if (typeof b.detail === 'string') return b.detail;
    }
  } catch {
    // no JSON body — fall through to the status text.
  }
  return res.statusText || `request failed (${res.status})`;
}

export type SubmitReportResult =
  | { ok: true; eventId: string }
  | { ok: false; status: number; message: string };

/** POST /cm/discrepancy. Throws synchronously (via buildReportBody) before
 *  fetch is ever called when the description is invalid. */
export async function submitReport(
  input: ReportInput,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitReportResult> {
  const body = buildReportBody(input);
  const res = await fetchFn(DISCREPANCY_URL, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (res.status === 202) {
    const json = (await res.json().catch(() => ({}))) as { event_id?: string };
    return { ok: true, eventId: json.event_id ?? '' };
  }

  const message = await extractErrorMessage(res);
  return { ok: false, status: res.status, message };
}

/** Sorted, de-duplicated slot_ids from an asset's CM `installed` list — the
 *  component choices for the fault-report form. [] when there is no CM
 *  state yet (cold start) or it carries no installed parts. */
export function componentOptions(cm: CmState | undefined): string[] {
  if (!cm || !Array.isArray(cm.installed)) return [];
  const slots = new Set<string>();
  for (const item of cm.installed) {
    const slot = item?.slot_id;
    if (typeof slot === 'string' && slot.length > 0) {
      slots.add(slot);
    }
  }
  return Array.from(slots).sort();
}

// =============================================================================
// BIT-reported discrepancies awaiting operator confirmation
// =============================================================================
// asset_cm_state.manual_discrepancies entries carry a `sources` list (ADR-
// 0018-adjacent): one source per report of the SAME (component, fault_code)
// episode. A `telemetry_bit` source means the sim's BIT path raised it; an
// `operator_report` source means a human already filed/confirmed it via
// this same form's POST /cm/discrepancy. cm-service de-dupes on
// asset|component|fault_code, so once an operator report lands on the same
// episode, its `sources` array grows an `operator_report` entry rather than
// creating a second discrepancy.

export interface ManualDiscrepancySource {
  source: string;
  reported_by?: string;
  event_id?: string;
  reported_at_ns?: number;
  description?: string;
}

export interface ManualDiscrepancy {
  component: string;
  fault_code: string;
  detected_at_ns: number;
  sources: ManualDiscrepancySource[];
  [key: string]: unknown;
}

/** The discrepancy to surface as a "BIT detected this — record it?" card:
 *  the most recently detected entry that has a telemetry_bit source and NO
 *  operator_report source yet. null once an operator report lands on it
 *  (cm-service merges onto the same entry's sources — see the module
 *  docstring above) or when there is no such entry at all. */
export function bitOnlyDiscrepancy(
  discrepancies: ManualDiscrepancy[] | undefined,
): ManualDiscrepancy | null {
  if (!Array.isArray(discrepancies)) return null;
  let best: ManualDiscrepancy | null = null;
  for (const d of discrepancies) {
    const sources = Array.isArray(d?.sources) ? d.sources : [];
    const hasBit = sources.some((s) => s?.source === 'telemetry_bit');
    const hasOperatorReport = sources.some((s) => s?.source === 'operator_report');
    if (hasBit && !hasOperatorReport) {
      if (!best || (d.detected_at_ns ?? 0) > (best.detected_at_ns ?? 0)) {
        best = d;
      }
    }
  }
  return best;
}

function formatUtcHHMM(ns: number): string {
  const ms = Math.floor((ns ?? 0) / 1e6);
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Card copy for a BIT-only discrepancy: catalog text when the code is in
 *  this asset's fault-isolation catalog, the bare code otherwise — either
 *  way followed by "(code)" so the code itself is always visible. Time is
 *  detected_at_ns rendered as UTC HH:MM. */
export function describeBitDiscrepancy(
  entry: ManualDiscrepancy,
  catalogCodes: CatalogCode[] = [],
): string {
  const match = catalogCodes.find((c) => c.code === entry.fault_code);
  const label = match ? match.text : entry.fault_code;
  const time = formatUtcHHMM(entry.detected_at_ns);
  return `Fault detected on ${entry.component}: ${label} (${entry.fault_code}), ${time}Z. Record it?`;
}
