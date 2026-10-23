// Tests the framework-free controller directly (see lib/exerciseControl.ts's
// header) with a mocked fetch -- no React, no DOM. Mirrors linkControl.test.ts.
//
// THE RULE THESE TESTS GUARD: `status.activity` and `last_command` are two
// separate facts carried through untouched from the service's own JSON --
// never cross-read, never inferred from each other.
import { describe, expect, it, vi } from 'vitest';
import {
  createExerciseControlController, resetConfirmBody, type ExerciseSequenceRun, type ExerciseStatusBody,
} from '../exerciseControl';

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

  describe('named sequences', () => {
    const SEQ_STATUS: ExerciseStatusBody = {
      ...PAUSED_STATUS,
      sequences: [{ name: 'warm_up', label: 'Warm up', steps: 2, total_wait_s: 5, may_press: true }],
    };
    const RUN: ExerciseSequenceRun = {
      op: 'warm_up', label: 'Warm up', subject: 'supervisor.1',
      started_at: '2026-10-13T00:00:00Z', finished_at: null, state: 'running',
      steps: [
        { i: 0, kind: 'call', name: 'open', method: 'POST', url: 'http://h/x', state: 'running',
          status: null, error: null, at: '2026-10-13T00:00:00Z', done_at: null },
        { i: 1, kind: 'wait', name: null, wait_s: 5, state: 'pending', status: null, error: null,
          at: null, done_at: null },
      ],
    };

    async function polled(second: Response) {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(SEQ_STATUS), { status: 200 }))
        .mockResolvedValueOnce(second);
      const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
      await c.poll();
      return c;
    }

    it('403 on a declared sequence is a refusal with the served reason; kind stays ok', async () => {
      const c = await polled(new Response(JSON.stringify({ error: 'forbidden', reason: 'supervisor_only' }), { status: 403 }));
      await c.runOp('warm_up');
      expect(c.getState().kind).toBe('ok');
      expect(c.getState().refusal).toBe('supervisor_only');
    });

    it('403 on an undeclared op still gives forbidden', async () => {
      const c = await polled(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
      await c.runOp('stop');
      expect(c.getState().kind).toBe('forbidden');
    });

    it('202 on a sequence folds the run into status.sequence and last_command', async () => {
      const c = await polled(new Response(JSON.stringify(RUN), { status: 202 }));
      await c.runOp('warm_up');
      const st = c.getState();
      expect(st.kind).toBe('ok');
      expect(st.refusal).toBeUndefined();
      expect(st.status?.sequence).toEqual(RUN);
      expect(st.status?.last_command).toEqual({
        op: 'warm_up', at: RUN.started_at, status: 202, error: null, subject: 'supervisor.1', sequence: true,
      });
    });

    it('409 on a sequence is a refusal and last_command stays', async () => {
      const c = await polled(new Response(JSON.stringify({
        error: 'sequence already running', reason: 'sequence_running', op: 'other',
      }), { status: 409 }));
      await c.runOp('warm_up');
      expect(c.getState().refusal).toBe('sequence_running');
      expect(c.getState().status?.last_command).toEqual(PAUSED_STATUS.last_command);
    });
  });
});

describe('reset pre-flight and the confirmation body', () => {
  const PF = (over: object) => ({
    limit: 300,
    runtimes: [{ name: 'rt-a', open: 412, error: null }],
    over: ['rt-a'], open_over: 412, needs_confirmation: true, unreadable: false, ...over,
  });
  const preflightFrom = async (res: Response | Error) => {
    const fetchImpl = vi.fn();
    if (res instanceof Error) fetchImpl.mockRejectedValueOnce(res);
    else fetchImpl.mockResolvedValueOnce(res);
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
    return { view: await c.resetPreflight(), fetchImpl };
  };

  it('resetPreflight() GETs the pre-flight path and returns ready', async () => {
    const { view, fetchImpl } = await preflightFrom(new Response(JSON.stringify(PF({})), { status: 200 }));
    expect(fetchImpl.mock.calls[0][0]).toBe('/exercise/reset/preflight');
    expect(view.kind).toBe('ready');
  });

  it.each([
    ['403', new Response('{}', { status: 403 })],
    ['500', new Response('{}', { status: 500 })],
    ['unreadable', new Response(JSON.stringify(PF({ unreadable: true })), { status: 200 })],
    ['malformed', new Response('{"x":1}', { status: 200 })],
    ['transport', new Error('down')],
  ])('resetPreflight() %s -> unavailable', async (_n, res) => {
    const { view } = await preflightFrom(res as Response | Error);
    expect(view).toEqual({ kind: 'unavailable' });
  });

  it('the body is built only for a ready, over-limit, fully-read pre-flight', () => {
    const ready = (o: object) => ({ kind: 'ready' as const, preflight: PF(o) });
    expect(resetConfirmBody(ready({}))).toEqual({ confirm_cancel_open: true, seen_open: 412 });
    expect(resetConfirmBody(ready({ needs_confirmation: false, over: [], open_over: 0 }))).toBeUndefined();
    expect(resetConfirmBody(ready({ unreadable: true }))).toBeUndefined();
    expect(resetConfirmBody({ kind: 'unavailable' })).toBeUndefined();
    expect(resetConfirmBody({ kind: 'loading' })).toBeUndefined();
    expect(resetConfirmBody(null)).toBeUndefined();
  });

  it('runOp(reset) sends the JSON body only when given one', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const c = createExerciseControlController(fetchImpl as unknown as typeof fetch);
    await c.runOp('reset');
    await c.runOp('reset', { confirm_cancel_open: true, seen_open: 412 });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][1].body).toBeUndefined();
    expect(calls[1][1].body).toBe(JSON.stringify({ confirm_cancel_open: true, seen_open: 412 }));
    expect(calls[1][0]).toBe('/exercise/op/reset');
  });
});

describe('loop ops', () => {
  const ctl = (res: Response) =>
    createExerciseControlController((async () => res) as unknown as typeof fetch);

  it('a 409 loop-running refusal is shown as a refusal', async () => {
    const c = ctl(new Response(JSON.stringify({ refused: 'loop running', cycle: 2 }), { status: 409 }));
    await c.runOp('pause');
    expect(c.getState().refusal).toBe('loop running');
  });

  it('a 403 on loop is a refusal, not a loss of access', async () => {
    const c = ctl(new Response(JSON.stringify({ error: 'forbidden', reason: 'supervisor only' }), { status: 403 }));
    await c.runOp('loop');
    expect(c.getState().kind).not.toBe('forbidden');
    expect(c.getState().refusal).toBe('supervisor only');
  });

  it('a 202 loop start does not rewrite last_command', async () => {
    const status = new Response(JSON.stringify({
      adapter: { name: 'a', ops: [] }, last_command: null, reset: { measured_zero_at: null, verdict: null },
      activity: { state: 'unknown', label: 'x', window_s: 30, min_rate: 0.1, sources: [] },
    }), { status: 200 });
    const responses = [status, new Response(JSON.stringify({ loop: 'started', cycle: 1 }), { status: 202 })];
    const c = createExerciseControlController((async () => responses.shift()!) as unknown as typeof fetch);
    await c.poll();
    await c.runOp('loop');
    expect(c.getState().status?.last_command).toBeNull();
  });
});
