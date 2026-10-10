// Link control is read from the proxies, never invented by a component, and
// POSTed only from a user's own change handler. The effectful part is
// unit-tested in lib/__tests__/linkControl.test.ts against the
// framework-free controller; this file checks the screens are actually wired
// to it (a source-text check, not a mount, for the same no-jsdom reason as
// fleetTiersLinkIndependence.test.ts).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('link control wiring', () => {
  it('MaintainerApp, RegionalApp and TheaterReadinessPosture call useLinkControl()', () => {
    for (const file of ['MaintainerApp.tsx', 'RegionalApp.tsx', 'components/hq/TheaterReadinessPosture.tsx']) {
      expect(readSrc(file), file).toMatch(/useLinkControl\(\)/);
    }
  });

  it('HqApp and HqHeader do not', () => {
    for (const file of ['HqApp.tsx', 'components/hq/HqHeader.tsx']) {
      expect(readSrc(file), file).not.toMatch(/useLinkControl/);
    }
  });

  it('no mount-firing effect POSTs a commanded state', () => {
    for (const file of ['MaintainerApp.tsx', 'RegionalApp.tsx']) {
      expect(readSrc(file), file).not.toMatch(/useEffect\(\(\) => \{\s*fetch\('\/proxies\//);
    }
  });

  it('Root has no controller view', () => {
    expect(readSrc('Root.tsx')).not.toContain("'controller'");
  });

  it('no source file mentions the removed hook, the shared proxy, or the controller screen', () => {
    // Built by concatenation so this file never matches itself.
    const forbidden = ['use' + 'WanLink', '/proxies/' + 'hq' + '-link', 'Controller' + 'App'];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const f of forbidden) {
        expect(text.includes(f), `${path.relative(SRC, file)} contains ${f}`).toBe(false);
      }
    }
  });
});
