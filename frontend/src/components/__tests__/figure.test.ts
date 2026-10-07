// @vitest-environment jsdom
// The figure is a file the hub serves and the SPA injects into the page, so
// the sanitizer is tested against a crafted hostile figure as well as the
// real-shaped fixture. The fixture is read from disk rather than inlined so
// the test exercises the same markup a deployment would mount.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { figureUrl, isSafeIcn, prepareFigure } from '../releasability/figure';

// jsdom replaces the URL global, so import.meta.url is not usable here;
// vitest provides __dirname.
const FIXTURE = readFileSync(
  resolve(__dirname, '../../../../tests/fixtures/s1000d-array-module/ICN-ODMRAD-00001.svg'),
  'utf8',
);

function parse(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

describe('prepareFigure', () => {
  it('highlights exactly the named hotspot, keeping its existing class', () => {
    const out = prepareFigure(FIXTURE, 'sec-03');
    expect(out).not.toBeNull();
    expect(out!.found).toBe(true);
    const doc = parse(out!.svg);
    const active = [...doc.querySelectorAll('.active')];
    expect(active.map((e) => e.getAttribute('id'))).toEqual(['sec-03']);
    const cls = active[0].getAttribute('class')!.split(/\s+/);
    expect(cls).toContain('hotspot');
    expect(cls).toContain('active');
    expect(out!.svg).toContain('id="sec-03"');
  });

  it('keeps the own style element of the figure', () => {
    const out = prepareFigure(FIXTURE, 'sec-03')!;
    expect(parse(out.svg).querySelectorAll('style').length).toBeGreaterThan(0);
  });

  it('reports found=false and adds no active class for an unknown id', () => {
    const out = prepareFigure(FIXTURE, 'sec-99')!;
    expect(out.found).toBe(false);
    expect(parse(out.svg).querySelectorAll('.active').length).toBe(0);
  });

  it('treats the id as data, not a selector', () => {
    const out = prepareFigure(FIXTURE, 'sec-03"], svg [id="x')!;
    expect(out.found).toBe(false);
  });

  it('highlights nothing when no hotspot is named', () => {
    const out = prepareFigure(FIXTURE, null)!;
    expect(out.found).toBe(false);
    expect(parse(out.svg).querySelectorAll('.active').length).toBe(0);
  });

  it('strips script, handlers, links, external use, foreignObject and external style', () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="x()">
      <script>alert(1)</script>
      <style>@import url(https://x/a.css);</style>
      <style>.a { fill: red; }</style>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
      <a href="https://x"><rect id="r1" width="1" height="1" onclick="y()"/></a>
      <use href="https://x#a"/>
      <use xlink:href="https://x#a"/>
      <use href="#r1"/>
      <image href="https://x/p.png"/>
      <iframe/><object/><embed/>
      <g id="h" class="hotspot" ONMOUSEOVER="z()"/>
    </svg>`;
    const out = prepareFigure(hostile, 'h')!;
    expect(out).not.toBeNull();
    expect(out.found).toBe(true);
    const s = out.svg.toLowerCase();
    for (const bad of ['<script', 'onload', 'onclick', 'onmouseover', 'https://x', '<foreignobject',
      '@import', '<iframe', '<object', '<embed', '<image', '<a ']) {
      expect(s).not.toContain(bad);
    }
    const doc = parse(out.svg);
    expect(doc.querySelectorAll('use').length).toBe(1);
    expect(doc.querySelector('use')!.getAttribute('href')).toBe('#r1');
    expect(doc.querySelectorAll('style').length).toBe(1);
  });

  it('returns null for non-svg and malformed input', () => {
    expect(prepareFigure('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>', null)).toBeNull();
    expect(prepareFigure('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', null)).toBeNull();
    expect(prepareFigure('not xml at all', null)).toBeNull();
    expect(prepareFigure('<svg viewBox="0 0 1 1"/>', null)).toBeNull();
  });
});

describe('isSafeIcn / figureUrl', () => {
  it('accepts a plain figure number', () => {
    expect(isSafeIcn('ICN-ODMRAD-00001')).toBe(true);
    expect(figureUrl('ICN-ODMRAD-00001')).toBe('/figures/ICN-ODMRAD-00001.svg');
  });
  it('rejects anything that could leave the figures directory or is not a string', () => {
    for (const bad of ['../a', 'a/b', '', 'a b', 'a..b', '.hidden', 'a'.repeat(129), 'a?b', 'a%2fb', 5, null, undefined, {}]) {
      expect(isSafeIcn(bad)).toBe(false);
    }
    expect(isSafeIcn('a'.repeat(128))).toBe(true);
  });
});
