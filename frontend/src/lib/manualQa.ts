// =============================================================================
// manualQa — the maintainer's "ask the manual" panel: scope, request, and
// the render-gate that decides whether an answer is ever shown.
// =============================================================================
// POST /manual/ask goes through the gateway (PEP), scoped to the data
// modules (DMCs) currently in view for the selected asset. The server is the
// real authority on whether an answer carries valid citations, but this
// module re-checks the same rule client-side (citationsInScope /
// shouldRenderAnswer) so a server bug, a future server change, or a bad
// prop somewhere upstream can never put uncited answer text on screen.
//
// Server contract:
//   POST /manual/ask  body {asset_id, question, dmcs: [...]}  ->
//     200 {status: "answered", answer, citations: [{dmc, title?, step?}]}
//     200 {status: "no_cited_answer", reason}
//     400 (bad request shape) | 401/403 (no session) | 404 (not configured
//     at this tier, or asset not visible) | 502 (upstream unavailable)
//
// Kept dependency-free (fetchFn injected), same discipline as
// lib/cmReport.ts, so this is testable in vitest's node environment with no
// DOM and no mocked global fetch.
import type { CatalogCode } from './cmReport';

const MANUAL_ASK_URL = '/manual/ask';

export interface Citation {
  dmc: string;
  title?: string;
  step?: string;
}

export type AskResult =
  | { kind: 'answered'; answer: string; citations: Citation[] }
  | { kind: 'no_cited_answer'; reason: string }
  /** The route doesn't exist at this tier, or the asset isn't visible to
   *  this viewer — the server returns a plain 404 for both and the caller
   *  can't (and doesn't need to) tell them apart: either way there is
   *  nothing to show. */
  | { kind: 'hidden' }
  /** No authenticated subject (401) or the subject was denied (403) —
   *  left for whatever already handles a lost session elsewhere in the
   *  app; this module raises nothing of its own for it. */
  | { kind: 'no_session' }
  /** The upstream answering service errored, timed out, or the request
   *  itself never reached the network. */
  | { kind: 'unavailable' }
  /** The scope this question would have been asked with is empty — never
   *  sent at all. Distinct from `unavailable`: nothing was asked of
   *  anything, let alone refused. */
  | { kind: 'no_scope' }
  /** Anything else unexpected (400, a malformed 200 body, …). */
  | { kind: 'error'; status: number; message: string };

export interface AskManualQuestionInput {
  assetId: string;
  question: string;
  dmcs: string[];
}

function isCitation(x: unknown): x is Citation {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  if (typeof c.dmc !== 'string' || !c.dmc) return false;
  if (c.title !== undefined && typeof c.title !== 'string') return false;
  if (c.step !== undefined && typeof c.step !== 'string') return false;
  return true;
}

function parseAskBody(body: unknown, status: number): AskResult {
  if (!body || typeof body !== 'object') {
    return { kind: 'error', status, message: 'malformed response' };
  }
  const b = body as Record<string, unknown>;
  if (b.status === 'answered') {
    const citations = Array.isArray(b.citations) ? b.citations.filter(isCitation) : [];
    if (typeof b.answer === 'string' && Array.isArray(b.citations) && citations.length === b.citations.length) {
      return { kind: 'answered', answer: b.answer, citations };
    }
    return { kind: 'error', status, message: 'malformed response' };
  }
  if (b.status === 'no_cited_answer') {
    const reason = typeof b.reason === 'string' ? b.reason : 'unknown';
    return { kind: 'no_cited_answer', reason };
  }
  return { kind: 'error', status, message: 'malformed response' };
}

async function extractMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    // no JSON body — fall through.
  }
  return res.statusText || `request failed (${res.status})`;
}

/** POSTs the question, scoped to `dmcs`. Never sends a request at all when
 *  `dmcs` is empty — the caller has nothing in view to ask against, so
 *  there is no scope to send and no answer that could ever cite anything
 *  in it. */
export async function askManualQuestion(
  input: AskManualQuestionInput,
  fetchFn: typeof fetch = fetch,
): Promise<AskResult> {
  if (input.dmcs.length === 0) {
    return { kind: 'no_scope' };
  }

  let res: Response;
  try {
    res = await fetchFn(MANUAL_ASK_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: input.assetId, question: input.question, dmcs: input.dmcs }),
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (res.status === 404) return { kind: 'hidden' };
  if (res.status === 401 || res.status === 403) return { kind: 'no_session' };
  if (res.status === 502) return { kind: 'unavailable' };
  if (!res.ok) {
    const message = await extractMessage(res);
    return { kind: 'error', status: res.status, message };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', status: res.status, message: 'malformed response' };
  }
  return parseAskBody(body, res.status);
}

/** The DMCs "in view": distinct `dmc` values carried by the asset's fault
 *  catalog, plus the dmc of an open BIT-discrepancy card when one is
 *  showing (it may name a code the catalog itself doesn't carry, so it's
 *  folded in rather than assumed to already be covered). Sorted so the
 *  panel's scope chips render in a stable order. Never derived any other
 *  way — there is no client-side guessing of DMCs beyond what the server
 *  already told this viewer about this asset. */
export function manualQaScope(codes: CatalogCode[], bitEntryDmc?: string | null): string[] {
  const set = new Set<string>();
  for (const c of codes) {
    if (typeof c.dmc === 'string' && c.dmc) set.add(c.dmc);
  }
  if (bitEntryDmc) set.add(bitEntryDmc);
  return Array.from(set).sort();
}

/** True only when every citation's dmc is inside `scope`, and there is at
 *  least one citation — an empty citations array is never "in scope",
 *  it's just empty. */
export function citationsInScope(citations: Citation[], scope: string[]): boolean {
  if (citations.length === 0) return false;
  const set = new Set(scope);
  return citations.every((c) => set.has(c.dmc));
}

/** THE ONLY GATE for rendering an answer's text. Re-checks the same
 *  citations-in-scope rule the gateway already enforces, independently,
 *  against the scope this question was actually sent with — so this
 *  module can never be made to show answer text that didn't come with a
 *  citation inside that scope, regardless of what a reply claims. */
export function shouldRenderAnswer(
  result: AskResult,
  scope: string[],
): result is { kind: 'answered'; answer: string; citations: Citation[] } {
  return result.kind === 'answered' && citationsInScope(result.citations, scope);
}
