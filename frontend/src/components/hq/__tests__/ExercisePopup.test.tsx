// Exercised with renderToStaticMarkup (no jsdom in this project, see
// HqHeader.test.tsx's header). Tests ExercisePopupView directly with
// explicit props -- the same container/pure-view split used by
// ManualQuestionPanel, for the same reason: no click events are available
// under renderToStaticMarkup, so `open`/`pendingConfirmOp` are passed in
// as props rather than driven by simulated clicks.
//
// THE RULE THESE TESTS GUARD: the activity badge text is built only from
// `activity`, and the last-command line only from `lastCommand` -- the
// view must never claim a running/paused state using the last command's
// op/status, and a cut rate source must read "unknown", never "paused".
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExercisePopupView, pillState, type ExercisePopupViewProps } from '../ExercisePopup';
import type {
  ExerciseActivity, ExerciseLastCommand, ExerciseResetJob, ExerciseSequence, ExerciseSequenceRun,
} from '../../../lib/exerciseControl';
import type { ResetPreflight, ResetPreflightView } from '../../../lib/exerciseControl';

const BASE: ExercisePopupViewProps = {
  kind: 'ok',
  ops: ['pause', 'resume', 'stop', 'run', 'restart'],
  activity: null,
  lastCommand: null,
  reset: null,
  open: false,
  onToggleOpen: () => {},
  onClose: () => {},
  pendingConfirmOp: null,
  onOpClick: () => {},
  onConfirm: () => {},
  onCancelConfirm: () => {},
};

const RUNNING: ExerciseActivity = {
  state: 'running', label: 'running', window_s: 30, min_rate: 0.1,
  sources: [{ url: 'http://x/metrics', reachable: true, rate: 5.2 }],
};

const PAUSED: ExerciseActivity = {
  state: 'paused', label: 'no entity PDUs', window_s: 30, min_rate: 0.1,
  sources: [{ url: 'http://x/metrics', reachable: true, rate: 0 }],
};

const UNKNOWN_CUT_LINK: ExerciseActivity = {
  state: 'unknown', label: 'unknown', window_s: 30, min_rate: 0.1,
  sources: [{ url: 'http://x/metrics', reachable: false, rate: null }],
};

const LAST_STOP: ExerciseLastCommand = {
  op: 'stop', at: '2026-10-06T00:00:00Z', status: 200, error: null, subject: 'supervisor.1',
};

describe('ExercisePopupView', () => {
  it('kind absent renders nothing', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} kind="absent" />);
    expect(html).toBe('');
  });

  it('kind loading renders nothing', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} kind="loading" />);
    expect(html).toBe('');
  });

  it('kind forbidden renders a disabled button titled "Exercise control: not authorised"', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} kind="forbidden" open={true} />);
    expect(html).toContain('Exercise control: not authorised');
    expect(html).not.toContain('supervisor');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).toContain('title="Exercise control: not authorised"');
    expect(html).toContain('data-state="EXERCISE"');
    // Forbidden must never open the popup body, even if open=true is passed.
    expect(html).not.toContain('data-testid="exercise-panel"');
    expect(html).not.toContain('Last command sent');
  });

  it('closed popup (open=false) renders the pill only, no panel', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={false} activity={RUNNING} />);
    expect(html).toContain('data-testid="exercise-pill"');
    expect(html).toContain('data-state="RUNNING"');
    expect(html).not.toContain('data-testid="exercise-panel"');
    expect(html).not.toContain('Running');
  });

  it('the closed pill shows RUNNING for running activity even when lastCommand.op is stop -- the rule', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={false} activity={RUNNING} lastCommand={LAST_STOP} />,
    );
    expect(html).toContain('data-state="RUNNING"');
    expect(html).not.toContain('IDLE');
  });

  it('stale dims the pill and says so in the title', () => {
    const fresh = renderToStaticMarkup(<ExercisePopupView {...BASE} activity={RUNNING} />);
    expect(fresh).not.toContain('opacity-60');
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} activity={RUNNING} stale={true} />);
    expect(html).toContain('opacity-60');
    expect(html).toContain('title="status stale"');
  });

  it('open renders the panel', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={RUNNING} />);
    expect(html).toContain('data-testid="exercise-panel"');
    expect(html).toContain('aria-label="Exercise"');
  });

  it('open + running activity shows "Running" and the per-source rate', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={RUNNING} />);
    expect(html).toContain('Running');
    expect(html).toContain('from entity PDU rate over 30 s');
    expect(html).toContain('http://x/metrics');
  });

  it('open + paused activity shows "Paused (no entity PDUs)", never "Running"', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={PAUSED} />);
    expect(html).toContain('Paused (no entity PDUs)');
    expect(html).not.toContain('>Running<');
  });

  it('a cut/unreachable rate source shows "Unknown", never "Paused" -- the architectural rule', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={UNKNOWN_CUT_LINK} />);
    expect(html).toContain('Unknown');
    expect(html).not.toContain('Paused');
    expect(html).toContain('unreachable');
  });

  it('last command line reports op/time/status/subject, never as a state claim', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={PAUSED} lastCommand={LAST_STOP} />,
    );
    expect(html).toContain('Last command sent: stop at 2026-10-06T00:00:00Z -&gt; 200 by supervisor.1');
  });

  it('no command sent yet renders the explicit empty-state line', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={PAUSED} lastCommand={null} />);
    expect(html).toContain('No command sent yet');
  });

  it('a transport error on the last command is shown as the error, not a status code', () => {
    const errored: ExerciseLastCommand = { op: 'run', at: '2026-10-06T00:02:00Z', status: null, error: 'connection refused', subject: 'supervisor.1' };
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={PAUSED} lastCommand={errored} />);
    expect(html).toContain('Last command sent: run at 2026-10-06T00:02:00Z -&gt; connection refused by supervisor.1');
  });

  it('reset line shows the measured-zero timestamp when present', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={PAUSED} reset={{ measured_zero_at: '2026-10-06T00:03:00Z', verdict: 'clean' }} />,
    );
    expect(html).toContain('Reset required before restart: last measured zero at 2026-10-06T00:03:00Z');
  });

  it('reset line shows "no measured zero on record" when absent', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={PAUSED} reset={{ measured_zero_at: null, verdict: null }} />,
    );
    expect(html).toContain('no measured zero on record');
  });

  it('without the reset Job, explains the two-halves restart flow and shows no button', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={PAUSED} />);
    expect(html).toContain('two halves');
    expect(html).toContain('then restart and run here');
    expect(html).not.toContain('Restart exercise');
  });

  it('a pending confirm on stop shows a confirm prompt, not yet an op call', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={RUNNING} pendingConfirmOp="stop" />,
    );
    expect(html).toContain('Confirm stop?');
  });

  it('renders one button per adapter op', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={RUNNING} ops={['pause', 'resume']} />);
    expect(html).toContain('Pause</button>');
    expect(html).toContain('Resume</button>');
    expect(html).not.toContain('Stop</button>');
  });

  it('each op button carries its label; an unknown op shows its name', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={RUNNING} ops={['run', 'pause', 'resume', 'stop', 'restart', 'warp']} />,
    );
    for (const label of ['Run', 'Pause', 'Resume', 'Stop', 'Restart', 'warp']) {
      expect(html).toContain(`${label}</button>`);
    }
  });

  describe('pillState', () => {
    it('running gives RUNNING', () => {
      expect(pillState(RUNNING, null).word).toBe('RUNNING');
    });

    it('paused gives IDLE, never PAUSED or STOPPED', () => {
      const st = pillState(PAUSED, null);
      expect(st.word).toBe('IDLE');
      expect(st.word).not.toMatch(/PAUSED|STOPPED/);
      expect(st.title).toBe('no entity PDUs (paused or stopped)');
    });

    it('an unknown or unreachable source, or no activity, gives UNKNOWN', () => {
      expect(pillState(UNKNOWN_CUT_LINK, null).word).toBe('UNKNOWN');
      expect(pillState(null, null).word).toBe('UNKNOWN');
    });

    it('a running reset job gives RESETTING even when activity is running', () => {
      const job: ExerciseResetJob = {
        available: true,
        latest: { name: 'j', state: 'running', started_at: '2026-10-08T00:00:00Z', finished_at: null, requested_by: 's' },
        error: null,
      };
      expect(pillState(RUNNING, job).word).toBe('RESETTING');
    });
  });

  describe('reset Job', () => {
    const JOB = (state: 'running' | 'succeeded' | 'failed', finished: string | null): ExerciseResetJob => ({
      available: true,
      latest: { name: 'rel-exercise-reset-abc', state, started_at: '2026-10-08T00:00:00Z', finished_at: finished, requested_by: 's' },
      error: null,
    });

    it('shows the Restart exercise button only when available', () => {
      const on = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} resetJob={JOB('running', null)} />);
      expect(on).toContain('Restart exercise</button>');
      const off = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={{ available: false, latest: null, error: null }} />,
      );
      expect(off).not.toContain('Restart exercise</button>');
      const old = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} />);
      expect(old).not.toContain('Restart exercise</button>');
    });

    it('the button needs a confirm prompt with its own wording', () => {
      const html = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={JOB('succeeded', null)} pendingConfirmOp="reset" />,
      );
      expect(html).toContain('Restart exercise: reset (deletes scenario state), then restart?');
      expect(html).not.toContain('Confirm reset?');
    });

    it('renders the job line for each state', () => {
      const run = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} resetJob={JOB('running', null)} />);
      expect(run).toContain('Reset job rel-exercise-reset-abc: running');
      const ok = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={JOB('succeeded', '2026-10-08T00:05:00Z')} />,
      );
      expect(ok).toContain('Reset job rel-exercise-reset-abc: succeeded (2026-10-08T00:05:00Z)');
      const bad = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={JOB('failed', '2026-10-08T00:06:00Z')} />,
      );
      expect(bad).toContain('Reset job rel-exercise-reset-abc: failed (2026-10-08T00:06:00Z)');
      const none = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={{ available: true, latest: null, error: null }} />,
      );
      expect(none).toContain('Reset job: none yet');
      expect(none).toContain('Restart exercise runs the reset in the cluster, then sends restart only if the reset measured zero.');
    });

    it('may_press false: disabled button and the supervisor-only line; true or absent: enabled', () => {
      const blocked = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={{ ...JOB('succeeded', null), may_press: false }} />,
      );
      expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>(?:<svg.*?<\/svg>)?Restart exercise<\/button>/);
      expect(blocked).toContain('Restart exercise: supervisor login only');
      expect(blocked).toContain('The reset destroys exercise state and takes about 13 minutes.');
      for (const job of [{ ...JOB('succeeded', null), may_press: true }, JOB('succeeded', null)]) {
        const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} resetJob={job} />);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:<svg.*?<\/svg>)?Restart exercise<\/button>/);
        expect(html).not.toContain('supervisor login only');
      }
    });

    describe('mode', () => {
      const MODE = (mode?: 'quick' | 'full'): ExerciseResetJob => ({ ...JOB('succeeded', null), mode });

      it('quick mode names the button, title, confirm, blocked text and job line', () => {
        const on = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} resetJob={MODE('quick')} />);
        expect(on).toContain('Quick reset</button>');
        expect(on).not.toContain('Restart exercise');
        expect(on).toContain('Clears exercise data in about a minute. Not measured; the exercise stays paused afterwards.');
        expect(on).toContain('Quick reset job rel-exercise-reset-abc: succeeded');
        const confirm = renderToStaticMarkup(
          <ExercisePopupView {...BASE} open={true} resetJob={MODE('quick')} pendingConfirmOp="reset" />,
        );
        expect(confirm).toContain(
          'Quick reset: pause the exercise and clear its data (not measured)? It stays paused; press Resume or Restart when ready.',
        );
        const blocked = renderToStaticMarkup(
          <ExercisePopupView {...BASE} open={true} resetJob={{ ...MODE('quick'), may_press: false }} />,
        );
        expect(blocked).toContain('Quick reset: supervisor login only');
      });

      it('full mode and a missing mode keep the Restart exercise texts', () => {
        for (const mode of ['full', undefined] as const) {
          const on = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} resetJob={MODE(mode)} />);
          expect(on).toContain('Restart exercise</button>');
          expect(on).not.toContain('Quick reset');
          expect(on).toContain('Reset job rel-exercise-reset-abc: succeeded');
          const confirm = renderToStaticMarkup(
            <ExercisePopupView {...BASE} open={true} resetJob={MODE(mode)} pendingConfirmOp="reset" />,
          );
          expect(confirm).toContain('Restart exercise: reset (deletes scenario state), then restart?');
        }
      });
    });

    it('shows a refusal reason', () => {
      const html = renderToStaticMarkup(
        <ExercisePopupView {...BASE} open={true} resetJob={JOB('running', null)} refusal="reset_running" />,
      );
      expect(html).toContain('Refused: reset_running');
    });
  });
});


describe('ExercisePopupView sequences', () => {
  const SEQS: ExerciseSequence[] = [
    { name: 'warm_up', label: 'Warm up', description: 'Bring the apparatus up', steps: 3, total_wait_s: 20, may_press: true },
    { name: 'cool_down', label: 'Cool down', steps: 1, total_wait_s: 0 },
  ];
  const step = (over: Record<string, unknown>) => ({
    i: 0, kind: 'call' as const, name: null, method: 'POST', url: 'http://apparatus.internal:8080/a/b?q=1',
    state: 'pending' as const, status: null, error: null, at: null, done_at: null, ...over,
  });
  const run = (over: Partial<ExerciseSequenceRun>): ExerciseSequenceRun => ({
    op: 'warm_up', label: 'Warm up', subject: 'supervisor.1', started_at: '2026-10-13T00:00:00Z',
    finished_at: null, state: 'running', steps: [], ...over,
  });
  const render = (extra: Partial<ExercisePopupViewProps>) =>
    renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} {...extra} />);
  const buttonTags = (html: string) =>
    html.match(/<button[^>]*data-testid="exercise-sequence-button"[^>]*>/g) ?? [];

  it('renders one button per sequence with data-op and a descriptive title', () => {
    const html = render({ sequences: SEQS });
    expect(buttonTags(html)).toHaveLength(2);
    expect(html).toContain('data-op="warm_up"');
    expect(html).toContain('data-op="cool_down"');
    expect(html).toContain('Bring the apparatus up (3 steps, about 20 s)');
    expect(html).toContain('Warm up');
  });

  it('may_press false disables the button with the note; absent does not', () => {
    const html = render({ sequences: [{ ...SEQS[0], may_press: false }, SEQS[1]] });
    expect(html).toContain('Warm up: supervisor login only');
    expect(html).not.toContain('Cool down: supervisor login only');
    const [warm, cool] = buttonTags(html);
    expect(warm).toContain('disabled=""');
    expect(cool).not.toContain('disabled=""');
  });

  it('a running run disables every sequence button with one line', () => {
    const html = render({ sequences: SEQS, sequence: run({}) });
    const tags = buttonTags(html);
    expect(tags).toHaveLength(2);
    for (const t of tags) expect(t).toContain('disabled=""');
    expect(html.match(/a sequence is running/g)).toHaveLength(1);
  });

  it('a finished run leaves the buttons enabled', () => {
    const html = render({ sequences: SEQS, sequence: run({ state: 'completed', finished_at: '2026-10-13T00:01:00Z' }) });
    for (const t of buttonTags(html)) expect(t).not.toContain('disabled=""');
    expect(html).not.toContain('a sequence is running');
  });

  it('the confirm step carries the sequence text', () => {
    const html = render({ sequences: SEQS, pendingConfirmOp: 'warm_up' });
    expect(html).toContain('Warm up: run the sequence? It changes the exercise for every viewer.');
  });

  it('the run panel shows state, subject, times and one row per step', () => {
    const html = render({
      sequences: SEQS,
      sequence: run({
        state: 'completed', finished_at: '2026-10-13T00:01:00Z',
        steps: [
          step({ i: 0, name: 'open valve', state: 'ok', status: 200 }),
          step({ i: 1, kind: 'wait', wait_s: 5, method: undefined, url: undefined, state: 'ok' }),
          step({ i: 2, state: 'pending' }),
        ],
      }),
    });
    expect(html).toContain('data-testid="exercise-sequence-run"');
    expect(html).toContain('data-state="completed"');
    expect(html).toContain('supervisor.1');
    expect(html).toContain('started 2026-10-13T00:00:00Z');
    expect(html).toContain('finished 2026-10-13T00:01:00Z');
    expect(html.match(/data-testid="exercise-sequence-step"/g)).toHaveLength(3);
    expect(html).toContain('data-i="1"');
    expect(html).toContain('open valve');
    expect(html).toContain('wait 5 s');
    expect(html).toContain('POST apparatus.internal:8080');
    expect(html).not.toContain('/a/b');
    expect(html).not.toContain('q=1');
    expect(html).not.toContain('halted at step');
  });

  it('a running run has no finished text', () => {
    const html = render({ sequences: SEQS, sequence: run({}) });
    expect(html).not.toContain('finished ');
  });

  it('a halted run shows the halted line; a failed step shows its status and error', () => {
    const html = render({
      sequences: SEQS,
      sequence: run({
        state: 'halted', finished_at: '2026-10-13T00:00:30Z',
        steps: [
          step({ i: 0, name: 'open valve', state: 'ok', status: 200 }),
          step({ i: 1, name: 'arm', state: 'failed', status: 503, error: 'upstream refused' }),
          step({ i: 2, name: 'fire', state: 'skipped' }),
        ],
      }),
    });
    expect(html).toContain('halted at step 1: later steps were skipped; nothing was undone');
    expect(html).toMatch(/data-i="1"[^>]*data-state="failed"|data-state="failed"[^>]*data-i="1"/);
    expect(html).toContain('503');
    expect(html).toContain('upstream refused');
  });

  it('no sequences means no buttons and no panel', () => {
    for (const extra of [{}, { sequences: [] }, { sequence: null }]) {
      const html = render(extra);
      expect(html).not.toContain('exercise-sequence-button');
      expect(html).not.toContain('exercise-sequence-run');
    }
  });

  it('last command from a sequence reads as started', () => {
    const html = render({
      lastCommand: { op: 'warm_up', at: '2026-10-13T00:00:00Z', status: 202, error: null, subject: 'supervisor.1', sequence: true },
    });
    expect(html).toContain('warm_up started by supervisor.1 at 2026-10-13T00:00:00Z (sequence)');
  });
});

describe('ExercisePopupView reset confirm: open Restate work', () => {
  const RJ = {
    available: true, mode: 'quick', latest: null, error: null, may_press: true,
  } as unknown as ExerciseResetJob;
  const render = (resetPreflight: ResetPreflightView) =>
    renderToStaticMarkup(
      <ExercisePopupView
        {...BASE} open={true} resetJob={RJ} pendingConfirmOp="reset" resetPreflight={resetPreflight}
      />,
    );
  const PF = (over: Partial<ResetPreflight>): ResetPreflight => ({
    limit: 300,
    runtimes: [{ name: 'rt-a', open: 40, error: null }, { name: 'rt-b', open: 2, error: null }],
    over: [], open_over: 0, needs_confirmation: false, unreadable: false, ...over,
  });

  it('loading: counting line, no confirm button yet, cancel still there', () => {
    const html = render({ kind: 'loading' });
    expect(html).toContain('Counting open Restate work…');
    expect(html).not.toContain('data-testid="exercise-confirm"');
    expect(html).toContain('cancel');
  });

  it('under the limit: the existing confirm plus the count line', () => {
    const html = render({ kind: 'ready', preflight: PF({}) });
    expect(html).toContain('Quick reset: pause the exercise and clear its data');
    expect(html).toContain('Open Restate invocations: 42 (limit 300)');
    expect(html).toContain('>yes</button>');
    expect(html).not.toContain('open invocations and reset');
  });

  it('over the limit: per-runtime counts, the cancel button and the bounded-time line', () => {
    const pf = PF({
      runtimes: [{ name: 'rt-a', open: 412, error: null }, { name: 'rt-b', open: 2, error: null }],
      over: ['rt-a'], open_over: 412, needs_confirmation: true,
    });
    const html = render({ kind: 'ready', preflight: pf });
    expect(html).toContain('Cancel 412 open invocations and reset');
    expect(html).toContain('rt-a: 412 open (limit 300)');
    expect(html).not.toContain('rt-b: 2 open');
    expect(html).toContain('bounded in time');
    expect(html).toContain('halts with the count left');
    expect(html).not.toContain('>yes</button>');
  });

  it('unavailable: the warning and the plain confirm', () => {
    const html = render({ kind: 'unavailable' });
    expect(html).toContain('Restate count unavailable — the reset may stop at its pre-flight');
    expect(html).toContain('>yes</button>');
    expect(html).not.toContain('open invocations and reset');
  });

  it('other ops keep their confirm and show no Restate line', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} pendingConfirmOp="stop" resetPreflight={{ kind: 'loading' }} />,
    );
    expect(html).toContain('Confirm stop?');
    expect(html).not.toContain('Restate');
  });
});
