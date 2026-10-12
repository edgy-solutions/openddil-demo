// Source guard: every shape in the schematics and the sensor-array view gets
// its material from SchematicMaterial, so each has all three render looks.
// A raw three material element would silently render one look in every mode.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMPONENTS = path.join(__dirname, '..', '..', 'components');
const RAW = /<mesh(Standard|Basic|Physical)Material/;

describe('schematic material guard', () => {
  const dir = path.join(COMPONENTS, 'platform-schematics');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.join(dir, f));
  files.push(path.join(COMPONENTS, 'SensorArrayView.tsx'));

  it('finds the schematic files', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    it(`${path.basename(file)} has no raw mesh*Material`, () => {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(RAW);
    });
  }
});
