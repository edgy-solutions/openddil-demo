// @ts-nocheck: the scripts are plain ESM
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectParts, hashFiles, listFiles, mergeDeployment, terrainUrls } from '../../../scripts/lib/pack.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function put(root: string, rel: string, content: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const script = path.resolve(__dirname, '../../../scripts/pack-terrain.mjs');

describe('hashFiles', () => {
  it('is 16 hex chars and stable across runs', () => {
    put(dir, 'dem/1/0/0.png', 'a'); put(dir, 'water.json', '{}');
    const h = hashFiles(dir);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashFiles(dir)).toBe(h);
  });
  it('does not depend on the order the files are given in', () => {
    put(dir, 'dem/1/0/0.png', 'a'); put(dir, 'dem/1/0/1.png', 'b');
    const files = listFiles(dir);
    expect(hashFiles(dir, [...files].reverse())).toBe(hashFiles(dir, files));
  });
  it('changes when a byte changes or a file is renamed', () => {
    put(dir, 'dem/1/0/0.png', 'a');
    const h = hashFiles(dir);
    put(dir, 'dem/1/0/0.png', 'b');
    const h2 = hashFiles(dir);
    expect(h2).not.toBe(h);
    fs.renameSync(path.join(dir, 'dem/1/0/0.png'), path.join(dir, 'dem/1/0/1.png'));
    expect(hashFiles(dir)).not.toBe(h2);
  });
});

describe('detectParts and terrainUrls', () => {
  it('finds the parts and their extensions', () => {
    const p = detectParts(['dem/3/1/2.png', 'imagery/3/1/2.webp', 'patch-imagery/9/1/2.jpg', 'water.json']);
    expect(p).toEqual({ dem: 'png', imagery: 'webp', 'patch-imagery': 'jpg', water: 'json' });
    expect(terrainUrls('abcdef0123456789', p)).toEqual({
      elevationUrl: '/deployment-overlay/terrain/abcdef0123456789/dem/{z}/{x}/{y}.png',
      imageryUrl: '/deployment-overlay/terrain/abcdef0123456789/imagery/{z}/{x}/{y}.webp',
      patchImageryUrl: '/deployment-overlay/terrain/abcdef0123456789/patch-imagery/{z}/{x}/{y}.jpg',
      waterUrl: '/deployment-overlay/terrain/abcdef0123456789/water.json',
    });
  });
  it('leaves out absent parts and rejects mixed extensions', () => {
    expect(terrainUrls('abcdef0123456789', detectParts(['water.json']))).toEqual({ waterUrl: '/deployment-overlay/terrain/abcdef0123456789/water.json' });
    expect(detectParts(['readme.txt'])).toEqual({});
    expect(() => detectParts(['imagery/3/1/2.jpg', 'imagery/3/1/3.png'])).toThrow(/mixed/);
  });
});

describe('mergeDeployment', () => {
  it('keeps other keys and existing terrain keys', () => {
    const out = mergeDeployment({ brand: { name: 'x' }, terrain: { basemap: 'imagery', waterUrl: 'old' } }, { waterUrl: 'new', elevationUrl: 'e' });
    expect(out).toEqual({ brand: { name: 'x' }, terrain: { basemap: 'imagery', waterUrl: 'new', elevationUrl: 'e' } });
  });
  it('creates the terrain block', () => {
    expect(mergeDeployment({}, { waterUrl: 'w' })).toEqual({ terrain: { waterUrl: 'w' } });
  });
});

describe('pack-terrain.mjs', () => {
  it('copies under the hash and merges deployment.json', () => {
    const src = path.join(dir, 'src'), overlay = path.join(dir, 'overlay');
    put(src, 'dem/2/1/1.png', 'dem'); put(src, 'water.json', '{}');
    put(overlay, 'deployment.json', JSON.stringify({ brand: 1 }));
    const run = () => execFileSync(process.execPath, [script, src, overlay], { encoding: 'utf8' });
    const out = run();
    const dep = JSON.parse(fs.readFileSync(path.join(overlay, 'deployment.json'), 'utf8'));
    const hash = hashFiles(src);
    expect(out).toContain(hash);
    expect(dep.brand).toBe(1);
    expect(dep.terrain.elevationUrl).toBe(`/deployment-overlay/terrain/${hash}/dem/{z}/{x}/{y}.png`);
    expect(dep.terrain.waterUrl).toBe(`/deployment-overlay/terrain/${hash}/water.json`);
    expect(fs.readFileSync(path.join(overlay, 'terrain', hash, 'dem/2/1/1.png'), 'utf8')).toBe('dem');
    expect(fs.readFileSync(path.join(overlay, 'deployment.json'), 'utf8').endsWith('}\n')).toBe(true);
    expect(run()).toContain('not copying');
  });
  it('fails with nothing to pack', () => {
    const src = path.join(dir, 'empty');
    put(src, 'notes.txt', 'x');
    expect(() => execFileSync(process.execPath, [script, src, path.join(dir, 'o')], { stdio: 'pipe' })).toThrow();
  });
});
