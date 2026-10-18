// @vitest-environment jsdom
// The initial /auth/me retries a transient failure, then surfaces the failed
// request instead of hanging on "checking session"; 401 and 404 are answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSession, SESSION_RETRY_DELAYS_MS } from '../useSession';
import { lastFailedRequest, __resetForTest } from '../../lib/lastFailedRequest';

const OK = () => new Response(JSON.stringify({
  authenticated: true, subject: 'u-1', username: 'u', nations: ['AAA'],
}), { status: 200 });
const ERR = (status: number, text = 'Service Unavailable') =>
  new Response('', { status, statusText: text });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetForTest();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const TOTAL = SESSION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

describe('useSession initial check', () => {
  it('retries a 503 and then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(ERR(503)).mockResolvedValueOnce(ERR(503))
      .mockResolvedValueOnce(OK());
    const { result } = renderHook(() => useSession());
    await settle(0);
    expect(result.current.authenticated).toBeUndefined();
    await settle(500 + 1000);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.sessionError).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('six failures surface sessionError with the status and attempts', async () => {
    fetchMock.mockImplementation(async () => ERR(503));
    const { result } = renderHook(() => useSession());
    await settle(TOTAL);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.current.authenticated).toBeUndefined();
    expect(result.current.sessionError).toMatchObject({
      method: 'GET', path: '/auth/me', status: 503, attempts: 6,
      detail: 'Service Unavailable',
    });
    expect(lastFailedRequest()).toMatchObject({ path: '/auth/me', status: 503 });
  });

  it('a network error ends with status null', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useSession());
    await settle(TOTAL);
    expect(result.current.sessionError).toMatchObject({
      status: null, detail: 'Failed to fetch', attempts: 6,
    });
  });

  it('a 401 is an answer: no retry, not authenticated', async () => {
    fetchMock.mockResolvedValue(ERR(401, 'Unauthorized'));
    const { result } = renderHook(() => useSession());
    await settle(TOTAL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.authenticated).toBe(false);
    expect(result.current.sessionError).toBeNull();
  });

  it('the interval recheck recovers from sessionError', async () => {
    fetchMock.mockImplementation(async () => ERR(503));
    const { result } = renderHook(() => useSession());
    await settle(TOTAL);
    expect(result.current.sessionError).not.toBeNull();
    fetchMock.mockImplementation(async () => OK());
    await settle(60_000);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.sessionError).toBeNull();
  });
});
