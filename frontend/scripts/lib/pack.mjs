// Hashing and URL building for scripts/pack-terrain.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Every file under `dir`, as '/'-separated paths relative to it, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 over every file in sorted relative-path order (path bytes, NUL, content); the first 16 hex chars. */
export function hashFiles(dir, files = listFiles(dir)) {
  const h = crypto.createHash('sha256');
  for (const rel of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(Buffer.from(rel));
    h.update(Buffer.from([0]));
    h.update(fs.readFileSync(path.join(dir, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

const IMAGE_EXT = new Set(['jpg', 'png', 'webp']);

/** The parts of a terrain source dir: the DEM, imagery and patch-imagery tile trees (with the one image extension each uses) and water.json. */
export function detectParts(files) {
  const parts = {};
  const tiles = (name, allowed) => {
    const exts = new Set();
    for (const f of files) {
      const m = f.match(new RegExp(`^${name}/[0-9]+/[0-9]+/[0-9]+[.]([a-z]+)$`));
      if (m) exts.add(m[1]);
    }
    if (!exts.size) return;
    for (const x of exts) if (!allowed.has(x)) throw new Error(`${name}: unsupported tile extension .${x}`);
    if (exts.size > 1) throw new Error(`${name}: mixed tile extensions (${[...exts].join(', ')})`);
    parts[name] = [...exts][0];
  };
  tiles('dem', new Set(['png']));
  tiles('imagery', IMAGE_EXT);
  tiles('patch-imagery', IMAGE_EXT);
  if (files.includes('water.json')) parts.water = 'json';
  return parts;
}

/** The deployment.json `terrain` URLs for the parts present, under /deployment-overlay/terrain/<hash>/. */
export function terrainUrls(hash, parts) {
  const base = `/deployment-overlay/terrain/${hash}`;
  const out = {};
  if (parts.dem) out.elevationUrl = `${base}/dem/{z}/{x}/{y}.${parts.dem}`;
  if (parts.imagery) out.imageryUrl = `${base}/imagery/{z}/{x}/{y}.${parts.imagery}`;
  if (parts['patch-imagery']) out.patchImageryUrl = `${base}/patch-imagery/{z}/{x}/{y}.${parts['patch-imagery']}`;
  if (parts.water) out.waterUrl = `${base}/water.json`;
  return out;
}

/** `deployment` with `urls` set in its `terrain` block; every other key, and other terrain keys, are kept. */
export function mergeDeployment(deployment, urls) {
  return { ...deployment, terrain: { ...(deployment.terrain ?? {}), ...urls } };
}
