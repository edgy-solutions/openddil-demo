// Tests the framework-free controller directly (see lib/exerciseControl.ts's
// header) with a mocked fetch -- no React, no DOM. Mirrors wanLink.test.ts.
//
// THE RULE THESE TESTS GUARD: `status.activity` and `last_command` are two
// separate facts carried through untouched from the service's own JSON --
// never cross-read, never inferred from each other.
import { describe, expect, it, vi } from 'vitest';
import { createExerciseControlController, type ExerciseStatusBody } from '../exerciseControl';

const PAUSED_STATUS: ExerciseStatusBody = {
  adapter: { name: 'stub', ops: ['pause', 'resume', 'stop', 'run', 'restart'] },
  last_command: {
    op: 'stop', at: '2026-10-06T00:00:00Z', status: 200, error: null, subject: 'supervisor.1',
  },
  activity: {
    state: 'paused', label: 'no entity PDUs', window_s: 30, min_rate: 0.1,
    sources: [{ url: 'http://x/metrics', reachable: true, rate: 0.0 }],
  },
  reset: { measured_zero_at: null, verdict: null },
};

describe('createExerciseControlController', () => {
  it('poll() issues exactly one GET and adopts the status body as-is', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      expect(init?.credentials).toBe('same-origin');
      return new Response(JSON.stringify(PAUSED_STATUS), { status: 200 });
    });
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.getState()).toEqual({ kind: 'ok', status: PAUSED_STATUS, stale: false });
  });

  it('poll() 404 -> kind absent, status null', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();

    expect(c.getState()).toEqual({ kind: 'absent', status: null, stale: false });
  });

  it('poll() 403 -> kind forbidden, status null', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();

    expect(c.getState()).toEqual({ kind: 'forbidden', status: null, stale: false });
  });

  it('poll() 401 -> kind forbidden, status null', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();

    expect(c.getState()).toEqual({ kind: 'forbidden', status: null, stale: false });
  });

  it('poll() network failure keeps the prior status and sets stale, without guessing absent/forbidden', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockRejectedValueOnce(new Error('fetch failed'));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();
    await c.poll();

    expect(c.getState()).toEqual({ kind: 'ok', status: PAUSED_STATUS, stale: true });
  });

  it('runOp() posts to /exercise/op/<op> and folds the response into last_command only', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        op: 'resume', at: '2026-10-06T00:01:00Z', status: 200, error: null, subject: 'supervisor.1',
      }), { status: 200 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();
    await c.runOp('resume');

    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/exercise/op/resume');
    expect(init.method).toBe('POST');

    const state = c.getState();
    expect(state.kind).toBe('ok');
    // activity is untouched by runOp -- still the GET's own value, not
    // derived from the op response in any way.
    expect(state.status?.activity).toEqual(PAUSED_STATUS.activity);
    expect(state.status?.last_command).toEqual({
      op: 'resume', at: '2026-10-06T00:01:00Z', status: 200, error: null, subject: 'supervisor.1',
    });
  });

  it('runOp() 403 -> kind forbidden, keeps no stale status guess', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();
    await c.runOp('stop');

    expect(c.getState().kind).toBe('forbidden');
  });

  it('runOp() transport error on a stopped adapter sets stale, not a fabricated last_command', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();
    await c.runOp('run');

    const state = c.getState();
    expect(state.stale).toBe(true);
    expect(state.status?.last_command).toEqual(PAUSED_STATUS.last_command);
  });
});
