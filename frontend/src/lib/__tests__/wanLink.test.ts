// No proxy call on mount; the slider starts from the proxy's real state.
// These test the framework-free controller directly (see lib/wanLink.ts's
// header for why) with a mocked fetch — no React, no DOM.
import { describe, expect, it, vi } from 'vitest';
import { createWanLinkController } from '../wanLink';

describe('createWanLinkController', () => {
  it('init() issues exactly one GET and zero POSTs, adopting the proxy state', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined(); // GET, not POST
      return new Response(JSON.stringify({ enabled: false }), { status: 200 });
    });
    const c = createWanLinkController(fetchImpl as unknown as typeof fetch);

    await c.init();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.getState()).toEqual({ enabled: false, error: false });
  });

  it('set() issues exactly one POST carrying the new value', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const c = createWanLinkController(fetchImpl as unknown as typeof fetch);

    await c.set(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/proxies/hq-link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    expect(c.getState().enabled).toBe(true);
  });

  it('a GET failure leaves state unknown (null) and flagged, with zero POSTs', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const c = createWanLinkController(fetchImpl as unknown as typeof fetch);

    await c.init();

    expect(c.getState()).toEqual({ enabled: null, error: true });
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method).not.toBe('POST');
    }
  });
});
