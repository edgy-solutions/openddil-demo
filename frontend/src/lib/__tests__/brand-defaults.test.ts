// =============================================================================
// /brand/ — the built-in defaults, with no overlay at all
// =============================================================================
// With no /deployment/ or /branding/ overlay mounted, every brand image the
// UI shows comes from public/brand/ in this image. Those are wired by path
// (index.html's favicon links, SignedOut's logo fallback), and nothing else
// checks that the paths and the files agree: a renamed or dropped file is a
// broken image on the sign-in screen, the first page anyone sees.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const BRAND_REF = /["'`(]\/brand\/([A-Za-z0-9._-]+)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function brandRefs(): Map<string, string> {
  const refs = new Map<string, string>();
  for (const file of [join(ROOT, 'index.html'), ...sources(join(ROOT, 'src'))]) {
    for (const m of readFileSync(file, 'utf8').matchAll(BRAND_REF)) {
      refs.set(m[1], file.slice(ROOT.length + 1));
    }
  }
  return refs;
}

describe('/brand/ defaults', () => {
  it('finds the references it is meant to check', () => {
    // Floor: a regex that matches nothing would make the next test pass vacuously.
    const refs = brandRefs();
    expect(refs.has('favicon.png')).toBe(true);
    expect(refs.has('logo.png')).toBe(true);
  });

  it('every /brand/ path referenced by the UI is a file in public/brand/', () => {
    const missing = [...brandRefs()]
      .filter(([name]) => !existsSync(join(ROOT, 'public', 'brand', name)))
      .map(([name, from]) => `/brand/${name} (referenced in ${from})`);
    expect(missing).toEqual([]);
  });
});
