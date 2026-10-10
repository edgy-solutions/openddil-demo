import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinkToxicsControl } from '../LinkToxics';

const noop = () => {};

function render(status: 'ready' | 'off' | 'forbidden', toxics: { latency_ms: number; jitter_ms: number; bandwidth_kb_s: number } | null): string {
  return renderToStaticMarkup(
    <LinkToxicsControl id="lt" toxics={toxics} status={status} onApply={noop} />,
  );
}

describe('LinkToxicsControl (static markup)', () => {
  it('status off renders nothing', () => {
    expect(render('off', { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 })).toBe('');
  });

  it('forbidden: every input and button is disabled with the not-authorised title', () => {
    const html = render('forbidden', { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 });
    expect((html.match(/<input[^>]*disabled=""/g) ?? []).length).toBe(3);
    expect((html.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(2);
    expect(html).toContain('title="Link control: not authorised"');
  });

  it('ready with {2000,0,0}: latency shows 2000 and the labels are amber', () => {
    const html = render('ready', { latency_ms: 2000, jitter_ms: 0, bandwidth_kb_s: 0 });
    expect(html).toMatch(/<input[^>]*id="lt-latency"[^>]*value="2000"/);
    expect(html).toMatch(/<input[^>]*id="lt-jitter"[^>]*value=""/);
    expect(html).toContain('text-amber-400');
    expect(html).not.toContain('text-slate-400');
    expect(html).not.toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain('>LAT<');
    expect(html).toContain('>JIT<');
    expect(html).toContain('>BW<');
    expect(html).toContain('>SET<');
    expect(html).toContain('>CLR<');
  });

  it('ready with all zeros: slate labels and empty values', () => {
    const html = render('ready', { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 });
    expect(html).not.toContain('text-amber-400');
    expect(html).toContain('text-slate-400');
    expect((html.match(/value=""/g) ?? []).length).toBe(3);
  });
});
