// =============================================================================
// arrivals -- the edge Arrivals panel's read and declare calls (ADR-0050 s3)
// =============================================================================
// Pure functions, fetchFn injected, so they test in vitest's node environment.
//
// Server contract (gateway/pep.py):
//   GET  /arrivals?edge_id=E  -> 200 {edge_id, undeclared[], expected[], units[],
//        nations[], declarable_nations[], baselines{variant: [id]}}
//        | 401/403/404 (route not offered to this viewer) | 5xx
//   POST /arrivals/declare    -> 201 {declared, baseline_assigned}
//        | 502 {declared:true, baseline_assigned:false, cause} (recorded, baseline not)
//        | 4xx/502 {error, cause, reference} (refused)
//
// THE CLIENT NEVER SENDS declared_by OR declared_at. The PEP stamps both from
// the session; buildDeclareBody emits a fixed key set, so an input object
// carrying extras can never leak one onto the wire.

export interface ArrivalPosition {
  lat?: number;
  lon?: number;
  [key: string]: unknown;
}

export interface UndeclaredArrival {
  asset_id: string;
  first_seen: string | null;
  last_seen: string | null;
  platform_variant: string;
  position: ArrivalPosition | null;
  candidates: string[];
}

export interface ExpectedArrival {
  serial: string;
  platform_variant: string | null;
  unit: string | null;
  owning_nation: string | null;
  releasable_to: string[];
  due_by: string | null;
  overdue: boolean;
}

export interface ArrivalsData {
  edge_id: string;
  undeclared: UndeclaredArrival[];
  expected: ExpectedArrival[];
  units: { id: string; name: string }[];
  nations: string[];
  declarable_nations: string[];
  baselines: Record<string, string[]>;
}

export type LoadArrivalsResult =
  | { kind: 'ok'; data: ArrivalsData }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

export async function loadArrivals(
  edgeId: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoadArrivalsResult> {
  let res: Response;
  try {
    res = await fetchFn(`/arrivals?edge_id=${encodeURIComponent(edgeId)}`, {
      credentials: 'same-origin',
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'request failed' };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: 'absent' };
  if (!res.ok) return { kind: 'error', message: `arrivals request failed (${res.status})` };
  try {
    const body = (await res.json()) as ArrivalsData;
    if (!body || !Array.isArray(body.undeclared) || !Array.isArray(body.expected)) {
      return { kind: 'error', message: 'malformed arrivals response' };
    }
    return { kind: 'ok', data: body };
  } catch {
    return { kind: 'error', message: 'malformed arrivals response' };
  }
}

export interface DeclareInput {
  assetId: string;
  edgeId: string;
  serial: string;
  unit: string;
  originatorNation: string;
  releasableTo: string[];
  /** '' or 'none' means no baseline. */
  baselineId: string;
  source: 'declare' | 'expect-confirm';
  confirmSerial?: string;
}

export interface DeclareBody {
  asset_id: string;
  edge_id: string;
  serial: string | null;
  unit: string;
  originator_nation: string;
  releasable_to: string[];
  baseline_id: string | null;
  source: 'declare' | 'expect-confirm';
  confirm_serial?: string;
}

/** Exactly the keys the PEP accepts; confirm_serial only for expect-confirm. */
export function buildDeclareBody(input: DeclareInput): DeclareBody {
  const serial = input.serial.trim();
  const baseline = input.baselineId.trim();
  const body: DeclareBody = {
    asset_id: input.assetId,
    edge_id: input.edgeId,
    serial: serial === '' ? null : serial,
    unit: input.unit,
    originator_nation: input.originatorNation,
    releasable_to: input.releasableTo,
    baseline_id: baseline === '' || baseline === 'none' ? null : baseline,
    source: input.source,
  };
  if (input.source === 'expect-confirm') body.confirm_serial = input.confirmSerial ?? '';
  return body;
}

export type SubmitDeclarationResult =
  | {
      kind: 'ok';
      record: Record<string, unknown> | null;
      baselineAssigned: boolean;
      /** Set when the declaration was recorded but the baseline was not. */
      warning?: string;
    }
  | { kind: 'refused'; status: number; reason: string }
  | { kind: 'error'; message: string };

export async function submitDeclaration(
  body: DeclareBody,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitDeclarationResult> {
  let res: Response;
  try {
    res = await fetchFn('/arrivals/declare', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'request failed' };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 201) {
    return {
      kind: 'ok',
      record: (json?.declared as Record<string, unknown>) ?? null,
      baselineAssigned: json?.baseline_assigned === true,
    };
  }
  if (res.status === 502 && json?.declared === true) {
    return {
      kind: 'ok',
      record: null,
      baselineAssigned: false,
      warning: typeof json.cause === 'string' ? json.cause : 'baseline assignment failed',
    };
  }
  const reason =
    (typeof json?.cause === 'string' && json.cause) ||
    (typeof json?.error === 'string' && json.error) ||
    res.statusText ||
    `request failed (${res.status})`;
  return { kind: 'refused', status: res.status, reason };
}

/** "lat, lon" to 4 dp from the server's position object; "—" when absent. */
export function formatPosition(pos: ArrivalPosition | null | undefined): string {
  if (!pos) return '—';
  const lat = pos.lat ?? pos.latitude;
  const lon = pos.lon ?? pos.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return '—';
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// --- HQ summary: GET /arrivals/summary -----------------------------------------
// Counts per edge, no ids. Open to any signed-in subject, so there is no
// role-based "absent" beyond the same 401/403/404 mapping as loadArrivals.
export interface ArrivalsSummaryEdge {
  edge_id: string;
  undeclared: number;
  expected: number;
  overdue: number;
}

export type LoadArrivalsSummaryResult =
  | { kind: 'ok'; data: ArrivalsSummaryEdge[] }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

const MALFORMED_SUMMARY = 'malformed arrivals summary';

export async function loadArrivalsSummary(
  fetchFn: typeof fetch = fetch,
): Promise<LoadArrivalsSummaryResult> {
  let res: Response;
  try {
    res = await fetchFn('/arrivals/summary', { credentials: 'same-origin' });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'request failed' };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: 'absent' };
  if (!res.ok) return { kind: 'error', message: `arrivals summary request failed (${res.status})` };
  try {
    const body = (await res.json()) as { edges?: unknown };
    if (!body || !Array.isArray(body.edges)) return { kind: 'error', message: MALFORMED_SUMMARY };
    for (const e of body.edges as Partial<ArrivalsSummaryEdge>[]) {
      if (
        !e ||
        !Number.isFinite(e.undeclared) ||
        !Number.isFinite(e.expected) ||
        !Number.isFinite(e.overdue)
      ) {
        return { kind: 'error', message: MALFORMED_SUMMARY };
      }
    }
    return { kind: 'ok', data: body.edges as ArrivalsSummaryEdge[] };
  } catch {
    return { kind: 'error', message: MALFORMED_SUMMARY };
  }
}

export function formatArrivalsSummary(e: ArrivalsSummaryEdge): string {
  const base = `undeclared ${e.undeclared} · expected ${e.expected}`;
  return e.overdue > 0 ? `${base} (${e.overdue} overdue)` : base;
}

/** Switcher badge counts; null when there is nothing to count (not loaded / absent / error).
 *  Overdue uses the same flag the Expected row's OVERDUE chip reads. */
export function arrivalsCounts(
  state: LoadArrivalsResult | undefined,
): { undeclared: number; expected: number; overdue: number } | null {
  if (!state || state.kind === 'absent' || state.kind === 'error') return null;
  return {
    undeclared: state.data.undeclared.length,
    expected: state.data.expected.length,
    overdue: state.data.expected.filter((x) => x.overdue).length,
  };
}
