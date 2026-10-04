// The edge's/regional view's own fleet classification must never be fed
// the COMMANDED link state (`!link1`). This can't be exercised by mounting
// MaintainerApp or RegionalSustainmentPosture (no jsdom /
// @testing-library/react in this project, and RegionalSustainmentPosture is
// a react-three-fiber scene with no WebGL test harness either — see its own
// __tests__/RegionalSustainmentPosture.test.ts for the established
// contract-test convention of not importing it). Both call sites were a
// one-line wiring defect at an exact, named location, so this reads the
// actual source text and asserts the buggy call shape is gone — genuinely
// red before the fix, green after.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

describe('fleet tiers never take the commanded link state', () => {
  it('MaintainerApp does not pass !link1 into useFleetTiers for its own fleet', () => {
    const src = readSrc('MaintainerApp.tsx');
    expect(src).not.toMatch(/useFleetTiers\(\s*fleet\.data\s*,\s*!\s*link1\s*\)/);
  });

  it('RegionalSustainmentPosture classifies hardwareFleet from the OBSERVED edge buffer, not !link1', () => {
    const src = readSrc('components/regional/RegionalSustainmentPosture.tsx');
    expect(src).not.toMatch(/useFleetTiers\(\s*hardwareFleet\s*,\s*!\s*link1\s*\)/);
  });
});
