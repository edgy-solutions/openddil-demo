// The link label is observed/fresh/unknown and never falls back to the
// commanded slider state. The classifier itself is unit-tested in
// lib/__tests__/linkIndicator.test.ts; this file checks Header and
// RegionalHeader are actually wired to it instead of the old `!link1`
// fallback (source-text check — see fleetTiersLinkIndependence.test.ts
// for why).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

describe('link indicator label never falls back to the commanded state', () => {
  it('Header no longer falls back to !link1 when status is absent', () => {
    const src = readSrc('components/Header.tsx');
    expect(src).not.toMatch(/status\.hq_link_severed\s*:\s*!\s*link1/);
  });

  it('RegionalHeader no longer falls back to !link1 when status is absent', () => {
    const src = readSrc('components/regional/RegionalHeader.tsx');
    expect(src).not.toMatch(/status\.hq_link_severed\s*:\s*!\s*link1/);
  });

  it('Header and RegionalHeader use the shared useLinkIndicator classifier', () => {
    for (const file of ['components/Header.tsx', 'components/regional/RegionalHeader.tsx']) {
      expect(readSrc(file)).toMatch(/useLinkIndicator\(/);
    }
  });
});
