// OSM water polygons (split, EPSG:4326 shapefile) -> a small GeoJSON for one area.
// usage: node water-clip.mjs <water_polygons.shp> <west> <south> <east> <north> <out.json>
// Records meeting the box are kept whole (not clipped); coordinates are rounded to 5 decimals.
import fs from 'node:fs';
import { filterShp, waterCollection } from './lib/shp.mjs';

const [, , shp, w, s, e, n, out] = process.argv;
const box = [w, s, e, n].map(Number);
if (!shp || !out || box.some((v) => !Number.isFinite(v)) || box[0] >= box[2] || box[1] >= box[3]) {
  console.error('usage: node water-clip.mjs <water_polygons.shp> <west> <south> <east> <north> <out.json>');
  process.exit(2);
}
const { features, points, records } = filterShp(shp, box);
const json = JSON.stringify(waterCollection(box, features));
fs.writeFileSync(out, json);
console.log(`${features.length} features of ${records} records, ${points} points, ${Buffer.byteLength(json)} bytes -> ${out}`);
