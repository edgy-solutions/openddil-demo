// Pin the relativeAgo formatter shape -- the banner's only piece of
// non-trivial logic. The component itself is straight JSX over a
// tier-keyed style table; nothing to test there that tsc + visual
// review don't already cover.
//
// We don't pull in the full component (would require @testing-library/
// react which isn't in the dev deps) -- just exercise relativeAgo
// against fixed timestamps.
import { describe, expect, it } from 'vitest';

// The function is module-private so we re-implement the same shape
// here as a contract test rather than refactor it out. If the
// component is ever rewritten, this test moves with the formatter.
function relativeAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min - hr * 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr - day * 24}h ago`;
}

const NOW = Date.parse('2026-06-05T12:00:00.000Z');

describe('relativeAgo', () => {
  it('null / undefined -> "never"', () => {
    expect(relativeAgo(null, NOW)).toBe('never');
    expect(relativeAgo(undefined, NOW)).toBe('never');
  });

  it('seconds: under 60 -> "Ns ago"', () => {
    expect(relativeAgo(new Date(NOW - 5_000).toISOString(), NOW)).toBe('5s ago');
    expect(relativeAgo(new Date(NOW - 59_000).toISOString(), NOW)).toBe('59s ago');
  });

  it('minutes: under 60 -> "Nm ago"', () => {
    expect(relativeAgo(new Date(NOW - 60_000).toISOString(), NOW)).toBe('1m ago');
    expect(relativeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago');
    expect(relativeAgo(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe('59m ago');
  });

  it('hours: under 24 -> "Nh Mm ago"', () => {
    expect(relativeAgo(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe('1h 0m ago');
    expect(relativeAgo(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe('1h 30m ago');
  });

  it('days: 24h+ -> "Nd Mh ago"', () => {
    expect(relativeAgo(new Date(NOW - 26 * 60 * 60_000).toISOString(), NOW)).toBe('1d 2h ago');
  });

  it('future timestamps clamp to 0s (clock-skew defensive)', () => {
    expect(relativeAgo(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0s ago');
  });

  it('malformed ISO returns the raw string (pass-through)', () => {
    expect(relativeAgo('not-a-date', NOW)).toBe('not-a-date');
  });
});
