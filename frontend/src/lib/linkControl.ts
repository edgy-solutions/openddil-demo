// =============================================================================
// linkControl — per-link commanded state, sourced from the proxies themselves
// =============================================================================
// One link = one child tier's uplink to its parent = one proxy. Each screen
// talks only to its own origin's PEP: GET /proxies/ lists this tier's own
// uplink and its direct children's; POST /proxies/uplink or
// /proxies/<child id> commands one of them.
//
// The commanded state is read from the proxy, never invented by the
// component: refresh() only GETs, and POSTs happen only from set(), which
// callers invoke from a user's own change handler. An unreadable listing
// leaves `enabled` at null ("unknown") rather than guessing true or false.
//
// FRAMEWORK-FREE ON PURPOSE. vitest runs in `environment: 'node'` with no
// jsdom (see vitest.config.ts), so effects never fire under
// `renderToStaticMarkup`. The effectful logic lives in this plain controller
// (tested against a mocked `fetch`) with a thin hook wrapper in
// hooks/useLinkControl.ts, mirroring lib/assetTier.ts + hooks/useFleetTiers.ts.

const LISTING_URL = '/proxies/';
const UPLINK_KEY = 'uplink';

export type LinkControlStatus = 'loading' | 'ready' | 'off' | 'forbidden' | 'error';

export interface UplinkControl { parent: string | null; enabled: boolean | null }
export interface ChildLinkControl { id: string; enabled: boolean | null }

export interface LinkControlState {
  status: LinkControlStatus;
  /** null at HQ, when control is off, and before the first listing. */
  uplink: UplinkControl | null;
  /** [] when control is off and before the first listing. */
  children: ChildLinkControl[];
}

export interface LinkControlController {
  getState(): LinkControlState;
  /** One GET /proxies/. Never POSTs. */
  refresh(): Promise<void>;
  /** POST the desired state for 'uplink' or a direct child's id. Call only
   *  from the user's own change handler. */
  set(target: 'uplink' | string, value: boolean): Promise<void>;
  subscribe(fn: () => void): () => void;
}

export function createLinkControlController(
  fetchImpl: typeof fetch = fetch,
): LinkControlController {
  let state: LinkControlState = { status: 'loading', uplink: null, children: [] };
  const listeners = new Set<() => void>();
  // Targets with a POST in flight: their optimistic value wins over any
  // listing that resolves meanwhile (else a poll started before the click
  // would flip the toggle back).
  const inFlight = new Set<string>();

  function setState(next: LinkControlState): void {
    state = next;
    for (const l of Array.from(listeners)) l();
  }

  // Keep the previous ids but forget what we knew about their state.
  function unknownState(status: LinkControlStatus): LinkControlState {
    return {
      status,
      uplink: state.uplink ? { ...state.uplink, enabled: null } : null,
      children: state.children.map((c) => ({ id: c.id, enabled: null })),
    };
  }

  function withEntry(
    target: string,
    enabled: boolean | null,
    status?: LinkControlStatus,
  ): LinkControlState {
    return {
      status: status ?? state.status,
      uplink: target === UPLINK_KEY && state.uplink ? { ...state.uplink, enabled } : state.uplink,
      children: state.children.map((c) => (c.id === target ? { id: c.id, enabled } : c)),
    };
  }

  function currentValue(target: string): boolean | null {
    if (target === UPLINK_KEY) return state.uplink ? state.uplink.enabled : null;
    return state.children.find((c) => c.id === target)?.enabled ?? null;
  }

  function known(target: string): boolean {
    if (target === UPLINK_KEY) return state.uplink !== null;
    return state.children.some((c) => c.id === target);
  }

  function adopt(target: string, listed: unknown): boolean | null {
    if (inFlight.has(target)) return currentValue(target);
    return typeof listed === 'boolean' ? listed : null;
  }

  const controller: LinkControlController = {
    getState() {
      return state;
    },

    async refresh() {
      try {
        const res = await fetchImpl(LISTING_URL, { credentials: 'same-origin' });
        if (res.status === 404) {
          setState({ status: 'off', uplink: null, children: [] });
          return;
        }
        if (res.status === 401 || res.status === 403) {
          // An expected refusal, not a fault — no console.error.
          setState(unknownState('forbidden'));
          return;
        }
        if (!res.ok) throw new Error(`GET ${LISTING_URL} -> ${res.status}`);
        const body = await res.json();
        const up = body?.uplink;
        const kids: Array<{ id: string; enabled?: unknown }> =
          Array.isArray(body?.children) ? body.children : [];
        setState({
          status: 'ready',
          uplink: up
            ? {
                parent: typeof up.parent === 'string' ? up.parent : null,
                enabled: adopt(UPLINK_KEY, up.enabled),
              }
            : null,
          children: kids.map((c) => ({ id: c.id, enabled: adopt(c.id, c.enabled) })),
        });
      } catch (err) {
        console.error('Link control error (GET /proxies/)', err);
        setState(unknownState('error'));
      }
    },

    async set(target: string, value: boolean) {
      if (!known(target)) return;
      const previous = currentValue(target);
      const url = target === UPLINK_KEY
        ? '/proxies/uplink'
        : `/proxies/${encodeURIComponent(target)}`;
      // Optimistic: the click flips the toggle immediately.
      inFlight.add(target);
      setState(withEntry(target, value));
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: value }),
        });
        if (res.status === 401 || res.status === 403) {
          setState(withEntry(target, previous, 'forbidden'));
        } else if (!res.ok) {
          throw new Error(`POST ${url} -> ${res.status}`);
        }
      } catch (err) {
        console.error(`Link control error (POST ${url})`, err);
        setState(withEntry(target, previous));
      } finally {
        inFlight.delete(target);
        // Converge: re-read so both ends of the link show the proxy's truth.
        await controller.refresh();
      }
    },

    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return controller;
}

const UNAVAILABLE_TITLE = 'Link state unknown — failed to read proxy status';
const FORBIDDEN_TITLE = 'Link control: not authorised';

/** Whether to render a toggle for this link, and how. `off` = no toggle at all. */
export function linkToggleAvailability(
  status: LinkControlStatus,
  enabled: boolean | null,
  from: string,
  to: string | null,
): { show: boolean; disabled: boolean; title: string } {
  if (status === 'off') return { show: false, disabled: true, title: '' };
  if (status === 'forbidden') return { show: true, disabled: true, title: FORBIDDEN_TITLE };
  if (status !== 'ready' || enabled === null) {
    return { show: true, disabled: true, title: UNAVAILABLE_TITLE };
  }
  return {
    show: true,
    disabled: false,
    title: `Cut or restore the uplink from ${from} to ${to ?? 'its parent'}`,
  };
}

