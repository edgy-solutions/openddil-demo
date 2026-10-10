// Tests the framework-free controller directly (see lib/exerciseControl.ts's
// header) with a mocked fetch -- no React, no DOM. Mirrors linkControl.test.ts.
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

  it('runOp(reset) 403 with a reason -> refusal set, kind stays ok (not forbidden)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden', reason: 'supervisor role required' }), { status: 403 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.poll();
    await c.runOp('reset');

    const state = c.getState();
    expect(state.kind).toBe('ok');
    expect(state.refusal).toBe('supervisor role required');
    expect(state.status?.last_command).toEqual(PAUSED_STATUS.last_command);
  });

  it('runOp(reset) 403 without a reason falls back to the error, then to refused (403)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);

    await c.runOp('reset');
    expect(c.getState().refusal).toBe('forbidden');
    await c.runOp('reset');
    expect(c.getState().refusal).toBe('refused (403)');
  });

  it('runOp(reset) 401 and runOp(pause) 403 still -> forbidden', async () => {
    for (const [op, status] of [['reset', 401], ['pause', 403]] as const) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status }));
      const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
      await c.runOp(op);
      expect(c.getState().kind).toBe('forbidden');
    }
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

  it('runOp(reset) 202 is folded as a sent command; no refusal', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        op: 'reset', at: '2026-10-08T00:00:00Z', job: 'rel-exercise-reset-abc', subject: 'supervisor.1',
      }), { status: 202 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
    await c.poll();
    await c.runOp('reset');
    const state = c.getState();
    expect(state.refusal).toBeUndefined();
    expect(state.status?.last_command).toMatchObject({ op: 'reset', status: 202, error: null, subject: 'supervisor.1' });
  });

  it('runOp(reset) 409 keeps last_command and exposes the reason', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED_STATUS), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'reset already running', reason: 'reset_running', job: 'rel-exercise-reset-abc',
      }), { status: 409 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
    await c.poll();
    await c.runOp('reset');
    const state = c.getState();
    expect(state.refusal).toBe('reset_running');
    expect(state.status?.last_command).toEqual(PAUSED_STATUS.last_command);
  });

  it('poll() carries reset_job through, and tolerates its absence', async () => {
    const withJob: ExerciseStatusBody = {
      ...PAUSED_STATUS, reset_job: { available: true, latest: null, error: null },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(withJob), { status: 200 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
    await c.poll();
    expect(c.getState().status?.reset_job?.available).toBe(true);
  });
});
