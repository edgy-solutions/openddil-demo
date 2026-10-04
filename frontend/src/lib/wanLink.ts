// =============================================================================
// wanLink — the WAN slider's commanded state, sourced from the proxy itself
// =============================================================================
// Why this exists: MaintainerApp, RegionalApp and HqApp each held
// `link1`/`wanActive` as local state seeded to `true` and POSTed it to the
// real toxiproxy hq-link proxy on every mount (and on every change) via a
// `useEffect([link1])`. Loading the page therefore re-enabled a link an
// operator had just cut — the commanded state was invented by the
// component, not read from the proxy it is supposed to be commanding.
//
// The fix: on construction, GET the proxy's real `enabled` state and adopt
// it. Never POST as a side effect of reading. POST only when the caller
// explicitly calls `set()` — i.e. from the user's own toggle handler.
//
// GET failure leaves `enabled` at `null` ("unknown") rather than guessing
// `true` or `false` — guessing here is exactly the defect this file
// removes. `error` is set so the UI can disable the control and explain
// why, instead of offering a toggle that lies about what it's toggling.
//
// FRAMEWORK-FREE ON PURPOSE. This project's vitest runs in `environment:
// 'node'` with no jsdom / @testing-library (see vitest.config.ts) — a
// mounted component's effects never fire under `renderToStaticMarkup`, so
// mount-time GETs and click-driven POSTs cannot be exercised by rendering
// anything. Splitting the effectful logic into a plain controller (tested
// directly against a mocked `fetch`, no React involved) plus a thin hook
// wrapper (hooks/useWanLink.ts) mirrors this codebase's existing
// lib/assetTier.ts (pure) + hooks/useFleetTiers.ts (hook) split.

const WAN_LINK_URL = '/proxies/hq-link';

export interface WanLinkState {
  enabled: boolean | null;
  error: boolean;
}

export interface WanLinkController {
  getState(): WanLinkState;
  /** GET the proxy's real state. Call once, on mount. Never POSTs. */
  init(): Promise<void>;
  /** POST the desired state. Call only from the user's own change handler
   *  — never from an effect reacting to `enabled` itself, or every
   *  GET-driven update would re-trigger a POST (the original defect). */
  set(value: boolean): Promise<void>;
  subscribe(fn: () => void): () => void;
}

export function createWanLinkController(
  fetchImpl: typeof fetch = fetch,
): WanLinkController {
  let state: WanLinkState = { enabled: null, error: false };
  const listeners = new Set<() => void>();

  function setState(next: WanLinkState): void {
    state = next;
    for (const l of Array.from(listeners)) l();
  }

  return {
    getState() {
      return state;
    },

    async init() {
      try {
        const res = await fetchImpl(WAN_LINK_URL);
        if (!res.ok) throw new Error(`GET ${WAN_LINK_URL} -> ${res.status}`);
        const body = await res.json();
        setState({ enabled: Boolean(body?.enabled), error: false });
      } catch (err) {
        console.error('Toxiproxy error (GET hq-link)', err);
        // Unknown, not a guess — see the file header.
        setState({ enabled: null, error: true });
      }
    },

    async set(value: boolean) {
      // Optimistic: the operator's click flips the toggle immediately
      // rather than waiting on the round trip (matches the responsiveness
      // of the code this replaces). The POST is fire-and-log on failure,
      // same as the original Phase 4c.5 behaviour.
      setState({ enabled: value, error: false });
      try {
        const res = await fetchImpl(WAN_LINK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: value }),
        });
        if (!res.ok) throw new Error(`POST ${WAN_LINK_URL} -> ${res.status}`);
      } catch (err) {
        console.error('Toxiproxy error (POST hq-link)', err);
      }
    },

    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
