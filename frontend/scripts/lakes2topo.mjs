// GeoJSON Natural Earth lakes -> quantised TopoJSON in world-atlas's shape
// (transform + delta arcs, one arc per ring), geometry only.
// usage: node lakes2topo.mjs <in.geojson> <out.json>
import fs from 'node:fs';
const [, , inPath, outPath] = process.argv;
const gj = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const Q = 1e5;
const scale = [360 / (Q - 1), 180 / (Q - 1)];
const translate = [-180, -90];
const arcs = [];
const qx = (lon) => Math.round((lon - translate[0]) / scale[0]);
const qy = (lat) => Math.round((lat - translate[1]) / scale[1]);
function ringArc(ring) {
  const pts = [];
  for (const [lon, lat] of ring) {
    const p = [qx(lon), qy(lat)];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  if (pts.length < 4) return null;
  let px = 0, py = 0;
  arcs.push(pts.map(([x, y]) => { const d = [x - px, y - py]; px = x; py = y; return d; }));
  return arcs.length - 1;
}
const poly = (rings) => rings.map(ringArc).filter((i) => i !== null).map((i) => [i]);
const geometries = [];
for (const f of gj.features) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === 'Polygon') {
    const p = poly(g.coordinates);
    if (p.length) geometries.push({ type: 'Polygon', arcs: p });
  } else if (g.type === 'MultiPolygon') {
    const m = g.coordinates.map(poly).filter((p) => p.length);
    if (m.length) geometries.push({ type: 'MultiPolygon', arcs: m });
  }
}
const topo = { type: 'Topology', transform: { scale, translate }, objects: { lakes: { type: 'GeometryCollection', geometries } }, arcs };
fs.writeFileSync(outPath, JSON.stringify(topo));
console.log(`${geometries.length} geometries, ${arcs.length} arcs, ${fs.statSync(outPath).size} bytes`);
