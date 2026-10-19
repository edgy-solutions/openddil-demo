import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxesIntersect, cleanRing, filterShp, parsePolygon, quantise, readShx, waterCollection } from '../../../scripts/lib/shp.mjs';

type P = [number, number];

// One Polygon record: header (number, content words, BE) then type 5, bbox, parts, points (LE).
function record(num: number, rings: P[][]): Buffer {
  const pts = rings.flat();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const content = Buffer.alloc(44 + rings.length * 4 + pts.length * 16);
  content.writeInt32LE(5, 0);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => content.writeDoubleLE(v, 4 + i * 8));
  content.writeInt32LE(rings.length, 36);
  content.writeInt32LE(pts.length, 40);
  let at = 0;
  rings.forEach((r, i) => { content.writeInt32LE(at, 44 + i * 4); at += r.length; });
  pts.forEach(([x, y], i) => {
    content.writeDoubleLE(x, 44 + rings.length * 4 + i * 16);
    content.writeDoubleLE(y, 44 + rings.length * 4 + i * 16 + 8);
  });
  const head = Buffer.alloc(8);
  head.writeInt32BE(num, 0);
  head.writeInt32BE(content.length / 2, 4);
  return Buffer.concat([head, content]);
}

function nullRecord(num: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeInt32BE(num, 0); b.writeInt32BE(2, 4); b.writeInt32LE(0, 8);
  return b;
}

function writePair(dir: string, name: string, records: Buffer[]) {
  const header = (len: number) => { const h = Buffer.alloc(100); h.writeInt32BE(9994, 0); h.writeInt32BE(len / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32); return h; };
  const shpLen = 100 + records.reduce((n, r) => n + r.length, 0);
  fs.writeFileSync(path.join(dir, `${name}.shp`), Buffer.concat([header(shpLen), ...records]));
  const idx = Buffer.alloc(records.length * 8);
  let off = 100;
  records.forEach((r, i) => { idx.writeInt32BE(off / 2, i * 8); idx.writeInt32BE((r.length - 8) / 2, i * 8 + 4); off += r.length; });
  fs.writeFileSync(path.join(dir, `${name}.shx`), Buffer.concat([header(100 + idx.length), idx]));
}

// Made-up boxes. Inside: a square with a repeated point and long decimals. Outside: far away. Holed: a square with a hole.
const inside: P[] = [[10.123456789, 20.1], [10.1234561, 20.1], [10.5, 20.1], [10.5, 20.5], [10.123456789, 20.5], [10.123456789, 20.1]];
const outside: P[] = [[50, 50], [51, 50], [51, 51], [50, 50]];
const outer: P[] = [[11, 21], [14, 21], [14, 24], [11, 24], [11, 21]];
const hole: P[] = [[12, 22], [12, 23], [13, 23], [13, 22], [12, 22]];

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-test-'));
  writePair(dir, 'w', [record(1, [inside]), record(2, [outside]), nullRecord(3), record(4, [outer, hole])]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('shp helpers', () => {
  it('reads the index', () => {
    const idx = readShx(path.join(dir, 'w.shx'));
    expect(idx).toHaveLength(4);
    expect(idx[0].offset).toBe(100);
    expect(idx[1].offset).toBe(idx[0].offset + idx[0].length + 8);
  });
  it('decodes parts into rings', () => {
    const p = parsePolygon(record(1, [outer, hole]).subarray(8));
    expect(p.bbox).toEqual([11, 21, 14, 24]);
    expect(p.rings).toEqual([outer, hole]);
  });
  it('rejects other shape types', () => {
    const b = Buffer.alloc(8); b.writeInt32LE(3, 0);
    expect(() => parsePolygon(b)).toThrow(/unsupported/);
  });
  it('quantises to 5 decimals and drops repeats and short rings', () => {
    expect(quantise(10.123456789)).toBe(10.12346);
    expect(Object.is(quantise(-0.000001), 0)).toBe(true);
    expect(cleanRing(inside)).toEqual([[10.12346, 20.1], [10.5, 20.1], [10.5, 20.5], [10.12346, 20.5], [10.12346, 20.1]]);
    expect(cleanRing([[0, 0], [1, 0], [0, 0]])).toBeNull();
    expect(boxesIntersect([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(boxesIntersect([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
  });
});

describe('filterShp', () => {
  it('keeps only the records meeting the box, whole', () => {
    const r = filterShp(path.join(dir, 'w.shp'), [10, 20, 15, 25]);
    expect(r.records).toBe(4);
    expect(r.features).toHaveLength(2);
    expect(r.features[0].geometry.type).toBe('Polygon');
    expect(r.features[0].geometry.coordinates).toHaveLength(1);
    expect(r.features[1].geometry.coordinates).toEqual([outer, hole]);
    expect(r.points).toBe(5 + 5 + 5);
  });
  it('a box over nothing gives no features', () => {
    expect(filterShp(path.join(dir, 'w.shp'), [100, 0, 101, 1]).features).toEqual([]);
  });
  it('a box over the far record picks only that one', () => {
    expect(filterShp(path.join(dir, 'w.shp'), [50.5, 50.5, 52, 52]).features).toHaveLength(1);
  });
});

describe('waterCollection', () => {
  it('has the coverage box, licence and features', () => {
    const f = [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }];
    const c = waterCollection([1, 2, 3, 4], f);
    expect(c).toMatchObject({ type: 'FeatureCollection', bbox: [1, 2, 3, 4], license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' });
    expect(c.features).toBe(f);
  });
});
