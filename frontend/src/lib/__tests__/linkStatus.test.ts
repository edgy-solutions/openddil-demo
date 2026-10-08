import { describe, expect, it } from 'vitest';
import {
  classifyLink,
  linkForFob,
  linkStateWord,
  summarizeLinks,
  summaryText,
  allLinksDown,
  type LinkStatusRow,
} from '../linkStatus';

const NOW = Date.parse('2026-10-08T12:00:30Z');
const fresh = '2026-10-08T12:00:28Z';

function row(over: Partial<LinkStatusRow> = {}): LinkStatusRow {
  return {
    id: 'edge-01',
    link_state: 'up',
    traffic: 'active',
    declared_idle: false,
    heartbeat_age_s: 1,
    last_heartbeat_at: fresh,
    bridge_lag: 0,
    updated_at: fresh,
    ...over,
  };
}

describe('classifyLink', () => {
  it.each(['up', 'idle', 'down', 'unknown'] as const)('passes %s through', (s) => {
    expect(classifyLink(row({ link_state: s }), NOW).state).toBe(s);
  });

  it('missing row is unknown', () => {
    expect(classifyLink(undefined, NOW)).toEqual({ state: 'unknown', declaredIdle: false });
  });

  it('updated_at older than 30 s is unknown whatever the row says', () => {
    const stale = '2026-10-08T11:59:59Z'; // 31 s old
    expect(classifyLink(row({ link_state: 'up', updated_at: stale }), NOW).state).toBe('unknown');
    expect(classifyLink(row({ link_state: 'down', updated_at: stale }), NOW).state).toBe('unknown');
  });

  it('exactly 30 s old is still trusted', () => {
    expect(classifyLink(row({ updated_at: '2026-10-08T12:00:00Z' }), NOW).state).toBe('up');
  });

  it('missing or unparseable updated_at is unknown', () => {
    expect(classifyLink(row({ updated_at: null }), NOW).state).toBe('unknown');
    expect(classifyLink(row({ updated_at: 'garbage' }), NOW).state).toBe('unknown');
  });

  it('unrecognized link_state is unknown', () => {
    expect(classifyLink(row({ link_state: 'degraded' }), NOW).state).toBe('unknown');
  });

  it('exposes declaredIdle', () => {
    expect(classifyLink(row({ link_state: 'idle', declared_idle: true }), NOW))
      .toEqual({ state: 'idle', declaredIdle: true });
  });
});

describe('labels, counts, tint', () => {
  const rows = new Map<string, LinkStatusRow>([
    ['edge-01', row({ id: 'edge-01', link_state: 'down' })],
    ['edge-03', row({ id: 'edge-03', link_state: 'idle', declared_idle: true })],
    ['edge-02', row({ id: 'edge-02', link_state: 'up' })],
    ['region-east', row({ id: 'region-east', link_state: 'unknown' })],
  ]);
  const ids = ['edge-01', 'edge-02', 'edge-03', 'region-east'];
  const links = ids.map((id) => linkForFob(rows, id, NOW));

  it('label words', () => {
    expect(links.map(linkStateWord)).toEqual(['DOWN', 'UP', 'IDLE · declared', 'UNKNOWN']);
    expect(linkStateWord({ state: 'idle', declaredIdle: false })).toBe('IDLE');
  });

  it('header counts, UNKNOWN only when present', () => {
    expect(summarizeLinks(links)).toEqual({ up: 1, idle: 1, down: 1, unknown: 1 });
    expect(summaryText(summarizeLinks(links))).toBe('1 UP · 1 IDLE · 1 DOWN · 1 UNKNOWN');
    expect(summaryText({ up: 2, idle: 0, down: 1, unknown: 0 })).toBe('2 UP · 0 IDLE · 1 DOWN');
  });

  it('tint only when every link is down', () => {
    const down = { state: 'down', declaredIdle: false } as const;
    const up = { state: 'up', declaredIdle: false } as const;
    expect(allLinksDown([down, down])).toBe(true);
    expect(allLinksDown([down, up])).toBe(false);
    expect(allLinksDown(links)).toBe(false);
    expect(allLinksDown([])).toBe(false);
  });

  it('a FOB with no row reads UNKNOWN, never UP', () => {
    const l = linkForFob(rows, 'edge-99', NOW);
    expect(l.state).toBe('unknown');
    expect(linkStateWord(l)).toBe('UNKNOWN');
  });
});
