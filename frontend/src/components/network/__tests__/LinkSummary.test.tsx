import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summaryText, type LinkCounts } from '../../../lib/linkStatus';
import { LinkSummary } from '../LinkSummary';

const html = (c: LinkCounts) => renderToStaticMarkup(<LinkSummary counts={c} />);
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&#x27;|&amp;/g, '');
const downSpan = (h: string) => /<span data-testid="link-summary-down" class="([^"]*)">([^<]*)<\/span>/.exec(h)!;

describe('LinkSummary', () => {
  it('zero down is emerald', () => {
    const m = downSpan(html({ up: 2, idle: 1, down: 0, unknown: 0 }));
    expect(m[1]).toBe('text-emerald-400');
    expect(m[2]).toBe('0 DOWN');
  });

  it('any down is rose', () => {
    const m = downSpan(html({ up: 2, idle: 0, down: 1, unknown: 0 }));
    expect(m[1]).toBe('text-rose-400');
    expect(m[2]).toBe('1 DOWN');
  });

  it('omits UNKNOWN at zero, shows a slate span otherwise', () => {
    expect(html({ up: 1, idle: 0, down: 0, unknown: 0 })).not.toContain('UNKNOWN');
    expect(html({ up: 0, idle: 0, down: 0, unknown: 9 })).toContain('<span class="text-slate-400">9 UNKNOWN</span>');
  });

  it('textContent equals summaryText', () => {
    const mixes: LinkCounts[] = [
      { up: 0, idle: 0, down: 0, unknown: 0 },
      { up: 3, idle: 1, down: 0, unknown: 0 },
      { up: 1, idle: 1, down: 1, unknown: 1 },
      { up: 0, idle: 0, down: 4, unknown: 9 },
    ];
    for (const c of mixes) expect(text(html(c))).toBe(summaryText(c));
  });
});
