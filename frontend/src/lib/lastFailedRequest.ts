// =============================================================================
// lastFailedRequest — the most recent request that failed, kept so a crash
// screen can name it
// =============================================================================
// "Something broke" with no request attached sends an operator to the
// network tab. This holds one record, in module memory only, for the app
// error boundary and the session-error screen to quote.
export interface FailedRequest {
  method: string;
  path: string;
  /** HTTP status, or null for a network error (no response at all). */
  status: number | null;
  detail: string;
  at: number;
}

let last: FailedRequest | null = null;

export function recordFailedRequest(r: FailedRequest): void {
  last = r;
}

export function lastFailedRequest(): FailedRequest | null {
  return last;
}

export function __resetForTest(): void {
  last = null;
}
