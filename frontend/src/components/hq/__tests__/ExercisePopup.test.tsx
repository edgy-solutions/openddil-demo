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
import { ExercisePopupView, type ExercisePopupViewProps } from '../ExercisePopup';
import type { ExerciseActivity, ExerciseLastCommand } from '../../../lib/exerciseControl';

const BASE: ExercisePopupViewProps = {
  kind: 'ok',
  ops: ['pause', 'resume', 'stop', 'run', 'restart'],
  activity: null,
  lastCommand: null,
  reset: null,
  open: false,
  onToggleOpen: () => {},
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

  it('kind forbidden renders a disabled button titled "Exercise control: supervisor only"', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} kind="forbidden" open={true} />);
    expect(html).toContain('Exercise control: supervisor only');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    // Forbidden must never open the popup body, even if open=true is passed.
    expect(html).not.toContain('Last command sent');
  });

  it('closed popup (open=false) renders the button only, no popup body', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={false} activity={RUNNING} />);
    expect(html).toContain('EXERCISE');
    expect(html).not.toContain('Running');
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

  it('explains the two-halves restart flow', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={PAUSED} />);
    expect(html).toContain('two halves');
    expect(html).toContain('an operator runs the reset elsewhere');
  });

  it('a pending confirm on stop shows a confirm prompt, not yet an op call', () => {
    const html = renderToStaticMarkup(
      <ExercisePopupView {...BASE} open={true} activity={RUNNING} pendingConfirmOp="stop" />,
    );
    expect(html).toContain('Confirm stop?');
  });

  it('renders one button per adapter op', () => {
    const html = renderToStaticMarkup(<ExercisePopupView {...BASE} open={true} activity={RUNNING} ops={['pause', 'resume']} />);
    expect(html).toContain('>pause<');
    expect(html).toContain('>resume<');
    expect(html).not.toContain('>stop<');
  });
});
