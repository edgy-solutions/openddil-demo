// Reading polygon records out of a shapefile without loading it:
// the .shx index gives each record's offset, and only records whose bbox meets
// the wanted box are read in full. Pure Node.
import fs from 'node:fs';

/** One entry per record: byte offset into the .shp and content length in bytes. */
export function readShx(shxPath) {
  const buf = fs.readFileSync(shxPath);
  if (buf.length < 100 || buf.readInt32BE(0) !== 9994) throw new Error(`${shxPath}: not a shapefile index`);
  const count = (buf.length - 100) / 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ offset: buf.readInt32BE(100 + i * 8) * 2, length: buf.readInt32BE(104 + i * 8) * 2 });
  }
  return out;
}

/** True when two [w, s, e, n] boxes overlap (touching counts). */
export function boxesIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Round to 5 decimals (~1 m). Adding 0 turns -0 into 0. */
export function quantise(v) {
  return Math.round(v * 1e5) / 1e5 + 0;
}

/** Quantise a ring of [lon, lat], drop consecutive duplicates; null when under 4 points remain. */
export function cleanRing(points) {
  const out = [];
  for (const [x, y] of points) {
    const p = [quantise(x), quantise(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length < 4 ? null : out;
}

/** Decode a record's content (from the shape type on) into { type, bbox, rings } (rings raw, unquantised). Type 0 -> null shape. */
export function parsePolygon(content) {
  const type = content.readInt32LE(0);
  if (type === 0) return { type, bbox: null, rings: [] };
  if (type !== 5) throw new Error(`unsupported shape type ${type} (only Polygon, 5)`);
  const bbox = [content.readDoubleLE(4), content.readDoubleLE(12), content.readDoubleLE(20), content.readDoubleLE(28)];
  const numParts = content.readInt32LE(36);
  const numPoints = content.readInt32LE(40);
  const partsAt = 44;
  const pointsAt = partsAt + numParts * 4;
  const rings = [];
  for (let p = 0; p < numParts; p++) {
    const from = content.readInt32LE(partsAt + p * 4);
    const to = p + 1 < numParts ? content.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
    const ring = [];
    for (let i = from; i < to; i++) {
      ring.push([content.readDoubleLE(pointsAt + i * 16), content.readDoubleLE(pointsAt + i * 16 + 8)]);
    }
    rings.push(ring);
  }
  return { type, bbox, rings };
}

/** The shape type and bbox of the record at `offset`, from its first 44 bytes only; bbox null for a null shape. */
function peek(fd, offset, length) {
  const head = Buffer.alloc(Math.min(44, 8 + length));
  fs.readSync(fd, head, 0, head.length, offset);
  const type = head.readInt32LE(8);
  if (type === 0) return { type, bbox: null };
  if (type !== 5) throw new Error(`unsupported shape type ${type} (only Polygon, 5) at byte ${offset}`);
  return { type, bbox: [head.readDoubleLE(12), head.readDoubleLE(20), head.readDoubleLE(28), head.readDoubleLE(36)] };
}

/** Polygon records of `shpPath` whose bbox meets `box` [w, s, e, n], as GeoJSON Polygon features
 *  (every part a ring, quantised). Whole records are kept, not clipped. */
export function filterShp(shpPath, box) {
  const index = readShx(shpPath.replace(/\.shp$/i, '.shx'));
  const fd = fs.openSync(shpPath, 'r');
  const features = [];
  let points = 0;
  try {
    for (const { offset, length } of index) {
      const { bbox } = peek(fd, offset, length);
      if (!bbox || !boxesIntersect(bbox, box)) continue;
      const content = Buffer.alloc(length);
      fs.readSync(fd, content, 0, length, offset + 8);
      const rings = parsePolygon(content).rings.map(cleanRing).filter(Boolean);
      if (!rings.length) continue;
      points += rings.reduce((n, r) => n + r.length, 0);
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { features, points, records: index.length };
}

/** The packaged water file: coverage bbox, licence, and the features. */
export function waterCollection(box, features) {
  return {
    type: 'FeatureCollection',
    bbox: box,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    source: 'osmdata.openstreetmap.de water-polygons-split-4326',
    features,
  };
}
