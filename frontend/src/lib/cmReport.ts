// =============================================================================
// cmReport — fault-report submission + fault-code loading
// =============================================================================
// Pure functions backing the "Report a fault" form: load the server's fault
// code list, build and submit a discrepancy report. Kept dependency-free
// (fetchFn injected) so this is testable in vitest's node environment with
// no DOM.
//
// Server contract (built in parallel by the gateway/PEP side):
//   GET  /cm/fault-codes  -> 200 [{code, text, severity}] | 401 | 404 (off)
//   POST /cm/discrepancy  -> 202 {event_id} | 400/401/403/404/413/415/502/503
//
// THE CLIENT NEVER SENDS A REPORTER. The PEP stamps the reporter from the
// session; buildReportBody emits exactly four keys (asset_id, component,
// fault_code, description) so an input object carrying extra fields (e.g. a
// caller that still has a stale reported_by/source lying around) can never
// leak one onto the wire.
import type { CmState } from '../hooks';

export type FaultCode = {
  code: string;
  text: string;
  severity: string;
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

/** Fault codes for the "Report a fault" form. null means the feature is off
 *  (not configured on this tier, or no session) — the caller hides the
 *  form rather than showing an error for either case. */
export async function loadFaultCodes(fetchFn: typeof fetch = fetch): Promise<FaultCode[] | null> {
  let res: Response;
  try {
    res = await fetchFn(FAULT_CODES_URL, { credentials: 'same-origin' });
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
  return Array.isArray(body) ? (body as FaultCode[]) : null;
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
