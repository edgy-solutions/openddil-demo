// Tests the framework-free link-control controller directly against a mocked
// fetch -- no React, no DOM (the project's vitest runs in a node environment).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkControlController } from '../linkControl';

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
      uplink: { parent: 'region-east', enabled: true },
      children: [{ id: 'edge-01', enabled: true }, { id: 'edge-02', enabled: false }],
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
      uplink: { parent: 'region-east', enabled: null },
      children: [{ id: 'edge-01', enabled: null }, { id: 'edge-02', enabled: null }],
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
