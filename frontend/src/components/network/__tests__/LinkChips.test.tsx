import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summaryText, type LinkCounts } from '../../../lib/linkStatus';
import { LinkChips } from '../LinkChips';

const html = (c: LinkCounts) => renderToStaticMarkup(<LinkChips counts={c} />);
const chip = (h: string, k: string) =>
  new RegExp(`<div data-testid="link-chip-${k}" data-count="[0-9]+" class="([^"]*)"`).exec(h);

describe('LinkChips', () => {
  it('dims zero-count chips and leaves nonzero ones undimmed', () => {
    const h = html({ up: 2, idle: 0, down: 0, unknown: 0 });
    expect(chip(h, 'up')![1]).not.toContain('opacity-[0.35]');
    expect(chip(h, 'idle')![1]).toContain('opacity-[0.35]');
    expect(chip(h, 'down')![1]).toContain('opacity-[0.35]');
  });

  it('glows only nonzero chips', () => {
    const h = html({ up: 2, idle: 0, down: 0, unknown: 0 });
    expect(h.match(/shadow-\[0_0_6px_currentColor\]/g)).toHaveLength(1);
  });

  it('carries the count on data-count', () => {
    const h = html({ up: 3, idle: 1, down: 0, unknown: 0 });
    expect(h).toContain('data-testid="link-chip-up" data-count="3"');
    expect(h).toContain('data-testid="link-chip-down" data-count="0"');
  });

  it('renders the unknown chip only when unknown > 0', () => {
    expect(html({ up: 1, idle: 0, down: 0, unknown: 0 })).not.toContain('link-chip-unknown');
    const h = html({ up: 0, idle: 0, down: 0, unknown: 4 });
    expect(h).toContain('data-testid="link-chip-unknown" data-count="4"');
    expect(chip(h, 'unknown')![1]).not.toContain('opacity-[0.35]');
  });

  it('aria-label matches summaryText', () => {
    for (const c of [
      { up: 1, idle: 0, down: 0, unknown: 0 },
      { up: 1, idle: 2, down: 3, unknown: 4 },
    ]) {
      expect(html(c)).toContain(`aria-label="${summaryText(c)}"`);
    }
  });
});

describe('LinkChips - unreachable', () => {
  const html = (c: LinkCounts & { unreachable?: number }) => renderToStaticMarkup(<LinkChips counts={c} />);
  it('shows the unreachable chip only when its count is above 0', () => {
    const base = { up: 1, idle: 0, down: 1, unknown: 0 };
    expect(html(base)).not.toContain('link-chip-unreachable');
    expect(html({ ...base, unreachable: 0 })).not.toContain('link-chip-unreachable');
    const h = html({ ...base, unreachable: 2 });
    expect(h).toContain('data-testid="link-chip-unreachable" data-count="2"');
    expect(h).toContain('2 UNREACHABLE');
  });
});
