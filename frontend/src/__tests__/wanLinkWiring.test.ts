// No proxy call on mount; the slider starts from the proxy's real state
// via the shared useWanLink hook. The effectful part (mount GET,
// change-driven POST) is unit-tested directly in lib/__tests__/wanLink.test.ts
// against the framework-free controller; this file checks the three apps
// are actually wired to it (a source-text check, not a mount, for the same
// no-jsdom reason as fleetTiersLinkIndependence.test.ts).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

describe('WAN link proxy call shape', () => {
  it('MaintainerApp does not POST on every link1 change via a mount-firing effect', () => {
    const src = readSrc('MaintainerApp.tsx');
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*fetch\('\/proxies\/uplink'/);
  });

  it('RegionalApp does not POST on every link1 change via a mount-firing effect', () => {
    const src = readSrc('RegionalApp.tsx');
    expect(src).not.toMatch(/useEffect\(\(\) => \{\s*fetch\('\/proxies\/uplink'/);
  });

  it('MaintainerApp, RegionalApp and HqApp all use the shared useWanLink() hook', () => {
    for (const file of ['MaintainerApp.tsx', 'RegionalApp.tsx', 'HqApp.tsx']) {
      expect(readSrc(file)).toMatch(/useWanLink\(\)/);
    }
  });
});
