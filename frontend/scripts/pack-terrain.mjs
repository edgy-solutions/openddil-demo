// Packages terrain data under a content hash in a deployment overlay.
// usage: node pack-terrain.mjs <src-dir> <overlay-dir>
// src-dir holds any of dem/, imagery/, patch-imagery/ ({z}/{x}/{y}.*) and water.json.
// Files are copied to <overlay-dir>/terrain/<hash>/ and the URLs written into
// <overlay-dir>/deployment.json (terrain block merged, other keys kept).
import fs from 'node:fs';
import path from 'node:path';
import { detectParts, hashFiles, listFiles, mergeDeployment, terrainUrls } from './lib/pack.mjs';

const [, , src, overlay] = process.argv;
if (!src || !overlay) {
  console.error('usage: node pack-terrain.mjs <src-dir> <overlay-dir>');
  process.exit(2);
}
const all = listFiles(src);
const parts = detectParts(all);
if (!Object.keys(parts).length) {
  console.error(`${src}: none of dem/, imagery/, patch-imagery/ or water.json found`);
  process.exit(1);
}
const files = all;
const hash = hashFiles(src, files);
const terrainDir = path.join(overlay, 'terrain');
const dest = path.join(terrainDir, hash);
let bytes = 0;
for (const f of files) bytes += fs.statSync(path.join(src, f)).size;

if (fs.existsSync(dest)) {
  console.log(`${dest} exists, not copying`);
} else {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
}

const depPath = path.join(overlay, 'deployment.json');
const current = fs.existsSync(depPath) ? JSON.parse(fs.readFileSync(depPath, 'utf8')) : {};
const urls = terrainUrls(hash, parts);
fs.mkdirSync(overlay, { recursive: true });
fs.writeFileSync(depPath, `${JSON.stringify(mergeDeployment(current, urls), null, 2)}\n`);

console.log(`hash ${hash}, ${files.length} files, ${bytes} bytes`);
for (const [k, v] of Object.entries(urls)) console.log(`${k}: ${v}`);
const old = fs.readdirSync(terrainDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^[0-9a-f]{16}$/.test(e.name) && e.name !== hash).map((e) => e.name);
if (old.length) console.log(`older bundles left in place (delete when unused): ${old.join(', ')}`);
