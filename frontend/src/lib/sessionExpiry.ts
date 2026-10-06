// =============================================================================
// sessionExpiry — one signal, three sources, and it means the SAME thing
// =============================================================================
// Expiry is not link loss. A 401 from a shape request, a 401 on an /auth/me
// re-check, and the browser's own clock reaching the deadline the server
// handed back are three different ways of learning the same fact: the
// viewer is no longer entitled. A network error, a timeout, a 5xx or a 503
// PDP-unavailable is a DIFFERENT fact — the viewer is still entitled, the
// link just failed — and none of those call `markSessionExpired`.
//
// A small module-level registry, same shape as lib/shapeErrors.ts: the gate
// in Root.tsx and the shape-error path in lib/shapeErrors.ts both need to
// set or read this from places no single React tree wraps, so this is
// deliberately not context.
import { useSyncExternalStore } from 'react';

let expired = false;
const listeners = new Set<() => void>();

function emit() {
  // Copy first: a listener that re-renders may subscribe or unsubscribe.
  for (const l of Array.from(listeners)) l();
}

/** A re-check 401, a shape refused for the session, and the deadline
 *  timer all call this. Idempotent: once
 *  expired, nothing un-expires a session short of a fresh login. */
export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  emit();
}

export function isSessionExpired(): boolean {
  return expired;
}

export function subscribeSessionExpiry(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Third argument is `getServerSnapshot` — see ShapeErrorBanner.tsx for why
 *  this project's renderToStaticMarkup-based test style needs it supplied
 *  even though there is no real server/client split for this store. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribeSessionExpiry, isSessionExpired, isSessionExpired);
}

/** Test-only: a fresh login starts a fresh module in production (full page
 *  navigation through /auth/callback), but the test process is long-lived,
 *  so tests need a way back to "not expired" between cases. */
export function __resetSessionExpiryForTest(): void {
  expired = false;
}
