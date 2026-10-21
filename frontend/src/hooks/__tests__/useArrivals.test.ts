// @vitest-environment jsdom
// useArrivals keeps the last ok result through a failed poll, retries sooner
// after a failure, and never serves one edge's result for another.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ArrivalsData, LoadArrivalsResult } from '../../lib/arrivals';

vi.mock('../../lib/arrivals', () => ({ loadArrivals: vi.fn() }));
import { loadArrivals } from '../../lib/arrivals';
import { useArrivals, POLL_MS, RETRY_MS } from '../useArrivals';

const load = vi.mocked(loadArrivals);
const data = (edge: string): ArrivalsData => ({
  edge_id: edge, undeclared: [], expected: [], units: [], nations: [], declarable_nations: [], baselines: {},
});
const OK = (edge: string): LoadArrivalsResult => ({ kind: 'ok', data: data(edge) });
const ERR = (message = 'boom'): LoadArrivalsResult => ({ kind: 'error', message });

const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  load.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useArrivals', () => {
  it('ok then error keeps the ok result and sets lastError; next ok clears it', async () => {
    load.mockResolvedValueOnce(OK('e1')).mockResolvedValueOnce(ERR('HTTP 503')).mockResolvedValue(OK('e1'));
    const { result } = renderHook(() => useArrivals('e1'));
    await settle();
    expect(result.current.state).toEqual(OK('e1'));
    expect(result.current.lastError).toBeNull();
    await settle(POLL_MS);
    expect(result.current.state).toEqual(OK('e1'));
    expect(result.current.lastError).toBe('HTTP 503');
    await settle(RETRY_MS);
    expect(result.current.state).toEqual(OK('e1'));
    expect(result.current.lastError).toBeNull();
  });

  it('error first serves the error', async () => {
    load.mockResolvedValue(ERR('down'));
    const { result } = renderHook(() => useArrivals('e1'));
    await settle();
    expect(result.current.state).toEqual(ERR('down'));
    expect(result.current.lastError).toBe('down');
  });

  it('retries about 3 s after an error, and warns once per run of failures', async () => {
    load.mockResolvedValue(ERR());
    renderHook(() => useArrivals('e1'));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    await settle(RETRY_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(load).toHaveBeenCalledTimes(2);
    await settle(RETRY_MS);
    expect(load).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('arrivals poll failed for e1: boom');
  });

  it('polls at 10 s after an ok', async () => {
    load.mockResolvedValue(OK('e1'));
    renderHook(() => useArrivals('e1'));
    await settle();
    await settle(POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('an edge change never serves the previous edge result', async () => {
    load.mockImplementation((id: string) => (id === 'e1' ? Promise.resolve(OK('e1')) : new Promise(() => {})));
    const { result, rerender } = renderHook(({ id }) => useArrivals(id), { initialProps: { id: 'e1' } });
    await settle();
    expect(result.current.state).toEqual(OK('e1'));
    rerender({ id: 'e2' });
    expect(result.current.state).toBeUndefined();
    expect(result.current.lastError).toBeNull();
    await settle();
    expect(result.current.state).toBeUndefined();
  });
});
