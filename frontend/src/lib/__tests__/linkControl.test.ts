// Tests the framework-free link-control controller directly against a mocked
// fetch -- no React, no DOM (the project's vitest runs in a node environment).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkControlController, linkToxicsAvailability } from '../linkControl';

interface Call { url: string; method: string; body: unknown }

const LISTING = {
  uplink: { proxy: 'uplink-edge-01', parent: 'region-east', enabled: true },
  children: [
    { id: 'edge-01', proxy: 'uplink-edge-01', enabled: true },
    { id: 'edge-02', proxy: 'uplink-edge-02', enabled: false },
  ],
};

function res(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A fetch whose GET /proxies/ and POSTs answer from the given handlers. */
function mockFetch(handlers: {
  get?: () => Response | Promise<Response>;
  post?: () => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return (handlers.get ?? (() => res(200, LISTING)))();
    return (handlers.post ?? (() => res(200)))();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('refresh', () => {
  it('is exactly one GET /proxies/ and zero POSTs; adopts uplink and children in order', async () => {
    const { impl, calls } = mockFetch({});
    const c = createLinkControlController(impl);
    await c.refresh();
    expect(calls).toEqual([{ url: '/proxies/', method: 'GET', body: undefined }]);
    expect(c.getState()).toEqual({
      status: 'ready',
      uplink: { parent: 'region-east', enabled: true, toxics: null },
      children: [
        { id: 'edge-01', enabled: true, toxics: null },
        { id: 'edge-02', enabled: false, toxics: null },
      ],
    });
  });

  it('404 -> off, uplink null, children []', async () => {
    const { impl } = mockFetch({ get: () => res(404) });
    const c = createLinkControlController(impl);
    await c.refresh();
    expect(c.getState()).toEqual({ status: 'off', uplink: null, children: [] });
  });

  it('403 -> forbidden, ids kept with enabled null, no console.error', async () => {
    let first = true;
    const { impl } = mockFetch({ get: () => { const r = first ? res(200, LISTING) : res(403); first = false; return r; } });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.refresh();
    expect(c.getState()).toEqual({
      status: 'forbidden',
      uplink: { parent: 'region-east', enabled: null, toxics: null },
      children: [
        { id: 'edge-01', enabled: null, toxics: null },
        { id: 'edge-02', enabled: null, toxics: null },
      ],
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('500 -> error, enabled null, console.error once', async () => {
    let first = true;
    const { impl } = mockFetch({ get: () => { const r = first ? res(200, LISTING) : res(500); first = false; return r; } });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.refresh();
    expect(c.getState().status).toBe('error');
    expect(c.getState().uplink?.enabled).toBeNull();
    expect(c.getState().children.map((k) => k.enabled)).toEqual([null, null]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('a thrown fetch -> error, enabled null', async () => {
    const impl = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const c = createLinkControlController(impl);
    await c.refresh();
    expect(c.getState()).toEqual({ status: 'error', uplink: null, children: [] });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('set', () => {
  it("set('edge-01', false) -> one POST to /proxies/edge-01 with {enabled:false}, then one GET", async () => {
    const { impl, calls } = mockFetch({});
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.set('edge-01', false);
    expect(calls).toEqual([
      { url: '/proxies/edge-01', method: 'POST', body: { enabled: false } },
      { url: '/proxies/', method: 'GET', body: undefined },
    ]);
  });

  it("set('uplink', true) -> POST /proxies/uplink", async () => {
    const { impl, calls } = mockFetch({});
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.set('uplink', true);
    expect(calls[0]).toEqual({ url: '/proxies/uplink', method: 'POST', body: { enabled: true } });
  });

  it('an unknown id, and uplink with uplink null -> zero fetches', async () => {
    const { impl, calls } = mockFetch({ get: () => res(200, { uplink: null, children: LISTING.children }) });
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.set('edge-99', true);
    await c.set('uplink', true);
    expect(calls).toEqual([]);
  });

  it('POST 403 -> that entry reverts, status forbidden', async () => {
    const { impl } = mockFetch({
      post: () => res(403),
      // The converging re-read also answers 403, so the final state is the
      // controller's own forbidden outcome.
      get: (() => { let n = 0; return () => (n++ === 0 ? res(200, LISTING) : res(403)); })(),
    });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.set('edge-02', true);
    expect(c.getState().status).toBe('forbidden');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('POST 403 reverts the entry to its previous value before the re-read', async () => {
    const seen: Array<boolean | null> = [];
    let gets = 0;
    const { impl } = mockFetch({
      post: () => res(403),
      get: () => (gets++ === 0 ? res(200, LISTING) : res(200, LISTING)),
    });
    const c = createLinkControlController(impl);
    c.subscribe(() => seen.push(c.getState().children[1]?.enabled ?? null));
    await c.refresh();
    await c.set('edge-02', true);
    expect(seen).toContain(true);          // optimistic
    expect(c.getState().children[1].enabled).toBe(false);   // reverted
    expect(c.getState().status).toBe('ready');
  });

  it('POST 500 -> that entry reverts', async () => {
    const { impl } = mockFetch({ post: () => res(500) });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.set('edge-01', false);
    expect(c.getState().children[0].enabled).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a listing that resolves while a POST is in flight does not overwrite the optimistic value', async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((r) => { releasePost = r; });
    const { impl } = mockFetch({
      post: async () => { await postGate; return res(200); },
    });
    const c = createLinkControlController(impl);
    await c.refresh();
    const pending = c.set('edge-01', false);
    // A poll that started before the click resolves now with the old value.
    await c.refresh();
    expect(c.getState().children[0].enabled).toBe(false);
    releasePost();
    await pending;
  });
});

const TOXIC_LISTING = {
  uplink: {
    proxy: 'uplink-edge-01', parent: 'region-east', enabled: true,
    toxics: { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 64 },
  },
  children: [
    { id: 'edge-01', proxy: 'uplink-edge-01', enabled: true,
      toxics: { latency_ms: 2000, jitter_ms: 50, bandwidth_kb_s: 0 } },
    { id: 'edge-02', proxy: 'uplink-edge-02', enabled: false, toxics: null },
    { id: 'edge-03', proxy: 'uplink-edge-03', enabled: true,
      toxics: { latency_ms: '5', jitter_ms: 0, bandwidth_kb_s: 0 } },
    { id: 'edge-04', proxy: 'uplink-edge-04', enabled: true,
      toxics: { latency_ms: 1, jitter_ms: 0 } },
    { id: 'edge-05', proxy: 'uplink-edge-05', enabled: true, toxics: 'slow' },
    { id: 'edge-06', proxy: 'uplink-edge-06', enabled: true },
  ],
};
const ZERO = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };

describe('listing toxics', () => {
  it('parses toxics per entry; anything but three finite numbers reads as null', async () => {
    const { impl } = mockFetch({ get: () => res(200, TOXIC_LISTING) });
    const c = createLinkControlController(impl);
    await c.refresh();
    const s = c.getState();
    expect(s.uplink?.toxics).toEqual({ latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 64 });
    expect(s.children.map((k) => k.toxics)).toEqual([
      { latency_ms: 2000, jitter_ms: 50, bandwidth_kb_s: 0 },
      null, null, null, null, null,
    ]);
  });

  it('a failed listing forgets the toxics', async () => {
    let first = true;
    const { impl } = mockFetch({
      get: () => { const r = first ? res(200, TOXIC_LISTING) : res(500); first = false; return r; },
    });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.refresh();
    expect(c.getState().uplink?.toxics).toBeNull();
    expect(c.getState().children.every((k) => k.toxics === null)).toBe(true);
  });
});

describe('setToxics', () => {
  it("POSTs exactly {toxics} to /proxies/edge-01, then one GET", async () => {
    const { impl, calls } = mockFetch({ get: () => res(200, TOXIC_LISTING) });
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    const t = { latency_ms: 2000, jitter_ms: 0, bandwidth_kb_s: 0 };
    await c.setToxics('edge-01', t);
    expect(calls).toEqual([
      { url: '/proxies/edge-01', method: 'POST', body: { toxics: t } },
      { url: '/proxies/', method: 'GET', body: undefined },
    ]);
  });

  it("POSTs to /proxies/uplink for 'uplink'", async () => {
    const { impl, calls } = mockFetch({ get: () => res(200, TOXIC_LISTING) });
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.setToxics('uplink', ZERO);
    expect(calls[0]).toEqual({ url: '/proxies/uplink', method: 'POST', body: { toxics: ZERO } });
  });

  it('an unknown target makes no fetch', async () => {
    const { impl, calls } = mockFetch({});
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.setToxics('edge-99', ZERO);
    expect(calls).toEqual([]);
  });

  it('403 sets forbidden without console.error', async () => {
    let gets = 0;
    const { impl } = mockFetch({
      post: () => res(403),
      get: () => (gets++ === 0 ? res(200, TOXIC_LISTING) : res(403)),
    });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.setToxics('edge-01', ZERO);
    expect(c.getState().status).toBe('forbidden');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a 500 logs the error and still re-reads', async () => {
    const { impl, calls } = mockFetch({ post: () => res(500), get: () => res(200, TOXIC_LISTING) });
    const c = createLinkControlController(impl);
    await c.refresh();
    calls.length = 0;
    await c.setToxics('edge-01', ZERO);
    expect(errorSpy).toHaveBeenCalled();
    expect(calls.map((k) => k.method)).toEqual(['POST', 'GET']);
  });

  it('is not optimistic: the state is the listing until it changes', async () => {
    const { impl } = mockFetch({ get: () => res(200, TOXIC_LISTING) });
    const c = createLinkControlController(impl);
    await c.refresh();
    await c.setToxics('edge-01', ZERO);
    expect(c.getState().children[0].toxics).toEqual({ latency_ms: 2000, jitter_ms: 50, bandwidth_kb_s: 0 });
  });
});

describe('linkToxicsAvailability', () => {
  it('off hides the group', () => {
    expect(linkToxicsAvailability('off', ZERO).show).toBe(false);
  });

  it('forbidden is disabled with the not-authorised title', () => {
    expect(linkToxicsAvailability('forbidden', ZERO)).toEqual({
      show: true, disabled: true, title: 'Link control: not authorised',
    });
  });

  it('not ready, or toxics null, is disabled with the unavailable title', () => {
    for (const a of [
      linkToxicsAvailability('loading', ZERO),
      linkToxicsAvailability('error', ZERO),
      linkToxicsAvailability('ready', null),
    ]) {
      expect(a.show).toBe(true);
      expect(a.disabled).toBe(true);
      expect(a.title).toBe('Link state unknown — failed to read proxy status');
    }
  });

  it('ready with toxics is enabled', () => {
    expect(linkToxicsAvailability('ready', ZERO)).toEqual({
      show: true, disabled: false, title: 'Latency, jitter and bandwidth on this link',
    });
  });
});
