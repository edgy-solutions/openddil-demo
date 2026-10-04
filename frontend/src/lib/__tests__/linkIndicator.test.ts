// The LINK label is observed, fresh, or admits it doesn't know — and never
// reads the commanded slider state. classifyLinkIndicator takes no
// link1/wanActive argument at all, which is what makes "the label never
// follows the slider" true by construction.
import { describe, expect, it } from 'vitest';
import { classifyLinkIndicator, STALE_S } from '../linkIndicator';

const BASE_MS = 1_000_000;

function freshStatus(overrides: Partial<{ hq_link_severed: boolean; probe_healthy: boolean }> = {}) {
  return {
    hq_link_severed: false,
    probe_healthy: true,
    updated_at: new Date(BASE_MS).toISOString(),
    ...overrides,
  };
}

describe('classifyLinkIndicator', () => {
  it('STALE_S is the documented 10s (projector writes every 2s)', () => {
    expect(STALE_S).toBe(10);
  });

  it('null status -> unknown', () => {
    expect(classifyLinkIndicator(null, false, BASE_MS)).toBe('unknown');
  });

  it('fresh + severed -> severed', () => {
    const status = freshStatus({ hq_link_severed: true });
    expect(classifyLinkIndicator(status, false, BASE_MS)).toBe('severed');
  });

  it('updated_at 11s old -> stale, even though severed=false', () => {
    const status = { hq_link_severed: false, probe_healthy: true, updated_at: new Date(0).toISOString() };
    expect(classifyLinkIndicator(status, false, 11_000)).toBe('stale');
  });

  it('isError -> stale regardless of freshness or severed value', () => {
    const status = freshStatus();
    expect(classifyLinkIndicator(status, true, BASE_MS)).toBe('stale');
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
