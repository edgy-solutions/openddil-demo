import { describe, expect, it } from 'vitest';
import { toneFromIndicator, toneFromLinkState, toneFromReadings, worstTone } from '../tone';
import type { LinkReading } from '../../../lib/linkStatus';

const r = (state: LinkReading['state'], declaredIdle = false): LinkReading =>
  ({ state, declaredIdle }) as LinkReading;

describe('tone', () => {
  it('indicator: up emerald, severed rose, probe_down amber, unknown/stale slate', () => {
    expect(toneFromIndicator('up')).toBe('ok');
    expect(toneFromIndicator('severed')).toBe('bad');
    expect(toneFromIndicator('probe_down')).toBe('warn');
    expect(toneFromIndicator('unknown')).toBe('neutral');
    expect(toneFromIndicator('stale')).toBe('neutral');
  });
  it('link state', () => {
    expect(toneFromLinkState('up')).toBe('ok');
    expect(toneFromLinkState('down')).toBe('bad');
    expect(toneFromLinkState('idle')).toBe('warn');
    expect(toneFromLinkState('idle', true)).toBe('ok');
    expect(toneFromLinkState('unknown')).toBe('neutral');
  });
  it('readings: none is null, all down bad, some down warn, unknown neutral', () => {
    expect(toneFromReadings([])).toBeNull();
    expect(toneFromReadings([r('down'), r('down')])).toBe('bad');
    expect(toneFromReadings([r('down'), r('up')])).toBe('warn');
    expect(toneFromReadings([r('unknown'), r('up')])).toBe('neutral');
    expect(toneFromReadings([r('up'), r('up')])).toBe('ok');
  });
  it('worstTone', () => {
    expect(worstTone(null)).toBe('neutral');
    expect(worstTone('ok', 'warn', null)).toBe('warn');
    expect(worstTone('bad', 'warn')).toBe('bad');
  });
});
