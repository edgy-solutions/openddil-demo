// The LINK label is observed, fresh, or admits it doesn't know — and never
// reads the commanded slider state. classifyLinkIndicator takes no
// link1/wanActive argument at all, which is what makes "the label never
// follows the slider" true by construction.
import { describe, expect, it } from 'vitest';
import { classifyLinkIndicator, STALE_ENTER_S, STALE_EXIT_S } from '../linkIndicator';

const BASE_MS = 1_000_000;

function freshStatus(overrides: Partial<{ hq_link_severed: boolean; probe_healthy: boolean }> = {}) {
  return {
    hq_link_severed: false,
    probe_healthy: true,
    updated_at: new Date(BASE_MS).toISOString(),
    ...overrides,
  };
}

function statusAgedBy(ageS: number, overrides: Partial<{ hq_link_severed: boolean; probe_healthy: boolean }> = {}) {
  return {
    hq_link_severed: false,
    probe_healthy: true,
    updated_at: new Date(BASE_MS - ageS * 1000).toISOString(),
    ...overrides,
  };
}

describe('classifyLinkIndicator', () => {
  it('STALE_ENTER_S is the measured sawtooth peak-safe threshold (30s)', () => {
    expect(STALE_ENTER_S).toBe(30);
  });

  it('STALE_EXIT_S is the hysteresis exit threshold (10s)', () => {
    expect(STALE_EXIT_S).toBe(10);
  });

  it('null status -> unknown', () => {
    expect(classifyLinkIndicator(null, false, BASE_MS)).toBe('unknown');
  });

  it('fresh + severed -> severed', () => {
    const status = freshStatus({ hq_link_severed: true });
    expect(classifyLinkIndicator(status, false, BASE_MS)).toBe('severed');
  });

  it('age 22s, no prev -> not stale (the measured sawtooth peak on a healthy HTTP/1.1 edge page)', () => {
    const status = statusAgedBy(22);
    expect(classifyLinkIndicator(status, false, BASE_MS)).not.toBe('stale');
  });

  it('age 31s, no prev -> stale', () => {
    const status = statusAgedBy(31);
    expect(classifyLinkIndicator(status, false, BASE_MS)).toBe('stale');
  });

  it('prev stale + age 15s -> stays stale (15 > STALE_EXIT_S)', () => {
    const status = statusAgedBy(15);
    expect(classifyLinkIndicator(status, false, BASE_MS, 'stale')).toBe('stale');
  });

  it('prev stale + age 9s -> falls through to probe_down/severed/up (9 <= STALE_EXIT_S)', () => {
    const status = statusAgedBy(9);
    expect(classifyLinkIndicator(status, false, BASE_MS, 'stale')).toBe('up');
  });

  it('isError -> stale regardless of age or prev', () => {
    const status = freshStatus();
    expect(classifyLinkIndicator(status, true, BASE_MS)).toBe('stale');
    expect(classifyLinkIndicator(status, true, BASE_MS, 'up')).toBe('stale');
  });

  it('fresh + not severed -> up, independent of any slider state (the function takes no link1 argument)', () => {
    const status = freshStatus({ hq_link_severed: false });
    expect(classifyLinkIndicator(status, false, BASE_MS)).toBe('up');
  });

  it('fresh + probe unhealthy -> probe_down (preserves today\'s behaviour)', () => {
    const status = freshStatus({ probe_healthy: false });
    expect(classifyLinkIndicator(status, false, BASE_MS)).toBe('probe_down');
  });
});
