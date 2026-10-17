import { describe, expect, it } from 'vitest';
import type { TacticalEvent } from '../../hooks';
import {
  collapseRepeats,
  describeTransition,
  eventCause,
  shortSeverity,
} from '../alertFeed';

const T0 = Date.parse('2026-01-01T12:00:00Z');
const min = (m: number) => new Date(T0 + m * 60_000).toISOString();
const TRANSITION = 'openddil.logistics.v1.severity-transition';

function ev(
  id: string,
  atMin: number,
  over: Partial<TacticalEvent> = {},
): TacticalEvent {
  return {
    id,
    source: 's',
    type: TRANSITION,
    subject: 'dis:9:9:1',
    severity: 'LOGISTICS_SEVERITY_CRITICAL',
    time: min(atMin),
    data: {},
    ...over,
  };
}

describe('collapseRepeats', () => {
  it('collapses five same-key events 4 minutes apart into one row', () => {
    const events = [0, -4, -8, -12, -16].map((m, i) => ev(`e${i}`, m));
    const rows = collapseRepeats(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
    expect(rows[0].event.id).toBe('e0');
    expect(rows[0].firstTime).toBe(min(-16));
  });

  it('starts a new row when the next is 40 minutes older than the group oldest', () => {
    const events = [0, -4, -8, -12, -16].map((m, i) => ev(`e${i}`, m));
    events.push(ev('old', -16 - 40));
    const rows = collapseRepeats(events);
    expect(rows).toHaveLength(2);
    expect(rows[0].count).toBe(5);
    expect(rows[1].event.id).toBe('old');
    expect(rows[1].count).toBe(1);
  });

  it('keeps other-asset events as their own rows without splitting the group', () => {
    const events = [
      ev('a0', 0),
      ev('b0', -1, { subject: 'dis:9:9:2' }),
      ev('a1', -4),
      ev('b1', -5, { subject: 'dis:9:9:2' }),
      ev('a2', -8),
    ];
    const rows = collapseRepeats(events);
    expect(rows.map((r) => [r.event.id, r.count])).toEqual([
      ['a0', 3],
      ['b0', 2],
    ]);
  });

  it('does not merge different severities', () => {
    const rows = collapseRepeats([
      ev('x0', 0),
      ev('x1', -1, { severity: 'LOGISTICS_SEVERITY_NON_OPERATIONAL' }),
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe('describeTransition', () => {
  it('shows previous and new for a severity-transition', () => {
    const e = ev('t', 0, {
      severity: 'LOGISTICS_SEVERITY_CRITICAL',
      data: { previous_severity: 'LOGISTICS_SEVERITY_DEGRADED' },
    });
    expect(describeTransition(e)).toBe('DEGRADED → CRITICAL');
  });
  it('shows only the new severity without a previous', () => {
    expect(describeTransition(ev('t', 0))).toBe('CRITICAL');
  });
  it('is null for a config event', () => {
    const e = ev('c', 0, { type: 'openddil.config.v1.status', severity: 'CONFIG_STATUS_MAJOR' });
    expect(describeTransition(e)).toBeNull();
  });
});

describe('shortSeverity', () => {
  it('strips known prefixes', () => {
    expect(shortSeverity('LOGISTICS_SEVERITY_CRITICAL')).toBe('CRITICAL');
    expect(shortSeverity('CONFIG_STATUS_MAJOR')).toBe('MAJOR');
    expect(shortSeverity('OTHER')).toBe('OTHER');
  });
  it('returns empty for empty input', () => {
    expect(shortSeverity('')).toBe('');
    expect(shortSeverity(null)).toBe('');
    expect(shortSeverity(undefined)).toBe('');
  });
});

describe('eventCause', () => {
  it('prefers the description, then the id, then null', () => {
    expect(eventCause(ev('a', 0, { data: { top_factor: 'f', top_factor_description: 'desc' } }))).toBe('desc');
    expect(eventCause(ev('b', 0, { data: { top_factor: 'f', top_factor_description: '' } }))).toBe('f');
    expect(eventCause(ev('c', 0, { data: { top_factor: '' } }))).toBeNull();
  });
});
