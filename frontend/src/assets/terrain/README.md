# Bundled terrain data

These files are build assets: `src/lib/terrainTiles.ts` imports them with `?url`, so Vite emits them as
`/assets/<name>-<hash>.json`, which nginx serves with an immutable cache header.

`land-10m.json`: world-atlas 2.0.2 `land-10m` (Natural Earth, public domain), TopoJSON.

`lakes-10m.json`: Natural Earth 10 m lakes (public domain), v5.1.2, from
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson

The HQ land mask subtracts these from world-atlas `land-10m`, which counts lakes as land.
The file is converted to quantised TopoJSON in world-atlas's shape, so `decodeLand` reads it:

    node scripts/lakes2topo.mjs ne_10m_lakes.geojson src/assets/terrain/lakes-10m.json

## Basemap and packaging

The terrain block of `deployment.json` (`terrain`) picks the basemap provider and where its data comes from.
Every key is optional.

| key | default | meaning |
|---|---|---|
| `basemap` | `relief` | `relief`: elevation tint and hillshade, no imagery. `imagery`: packaged open imagery. `licensed`: a deployment-supplied tile source. |
| `network` | `false` | Allow remote (scheme or `//`) URLs. |
| `elevationUrl` | `/deployment-overlay/terrain/dem/{z}/{x}/{y}.png` | Terrarium PNG tiles. |
| `imageryUrl` | `/deployment-overlay/terrain/imagery/{z}/{x}/{y}.jpg` | Base imagery (imagery and licensed only). |
| `patchImageryUrl` | imagery: none; licensed: `imageryUrl` | Close-up patches around clusters and assets. |
| `imageryMaxZoom` | imagery 14, licensed 19 | Cap for the base imagery mosaic. |
| `patchMaxZoom` | 19 | Cap for patches. |
| `landUrl` | bundled `land-10m.json` | Natural Earth land (coast mask). |
| `lakesUrl` | bundled `lakes-10m.json` | Natural Earth lakes, cut out of the land. |
| `waterUrl` | `/deployment-overlay/terrain/water.json` | OSM water polygons; used in place of Natural Earth inside the file's own coverage (see below). |
| `reliefPalette` | `sand` | `sand` or `slate` (dark). |
| `credits` | none (land: `Coastline: Natural Earth` while the packaged coastline is used) | Per-source credit lines: `elevation`, `imagery`, `patchImagery`, `land`, `water`. A credit is shown only when the config states it; a source in use without one logs a console warning once. |

`network: false` is the default: a remote URL in any URL key is refused with a console warning and the
packaged default is used instead. A source on another host needs `network: true`.

Data is packaged in the deployment overlay, which nginx serves at `/deployment-overlay/` (404 when absent),
under a content-hash directory:

    /deployment-overlay/terrain/<hash>/dem/{z}/{x}/{y}.png
    /deployment-overlay/terrain/<hash>/imagery/{z}/{x}/{y}.{jpg|png|webp}
    /deployment-overlay/terrain/<hash>/patch-imagery/{z}/{x}/{y}.{jpg|png|webp}
    /deployment-overlay/terrain/<hash>/water.json

Every part is optional. DEM zooms needed: up to z11 for the heightfield and up to z13 for the relief texture of the
regional AOI; the HQ surround uses z7.

### Tools

`scripts/pack-terrain.mjs` packs a source directory holding any of `dem/`, `imagery/`, `patch-imagery/` and `water.json`:

    node scripts/pack-terrain.mjs <src-dir> <overlay-dir>

It hashes the files (sha256 over the sorted relative paths and contents, first 16 hex chars), copies them to
`<overlay-dir>/terrain/<hash>/` (skipped if that directory exists), and writes the matching URLs
(`elevationUrl`, `imageryUrl`, `patchImageryUrl`, `waterUrl`) into the `terrain` block of
`<overlay-dir>/deployment.json`, keeping every other key. Older hash directories are left in place; delete them
when no longer referenced.

`scripts/water-clip.mjs` makes `water.json` from the OSM water polygons shapefile
(osmdata.openstreetmap.de, "water-polygons-split-4326", ODbL), reading only the records that meet the box:

    node scripts/water-clip.mjs water_polygons.shp <west> <south> <east> <north> water.json

Records are kept whole (not clipped) with coordinates rounded to 5 decimals. The output is a GeoJSON
FeatureCollection of Polygon features in lon/lat with a top-level `bbox` (the requested box, the file's coverage).
Each feature's rings are filled together with even-odd, so islands are inner rings. Without a `bbox` the coverage is
the bounds of all rings.

### Water coverage

The mask is Natural Earth land (minus lakes) everywhere. Inside the water file's `bbox` the file replaces the land:
the covered area is land, and the water polygons are cut out of it. Outside the box Natural Earth still draws the
coast, so the HQ surround and anything beyond the area stay correct. The OSM credit is shown only when the file
was used and its box overlaps the drawn area. A deployment that ships no `water.json` gets Natural Earth throughout.

### Caching

Everything under `terrain/<hash>/` is immutable: nginx sends `private, max-age=31536000, immutable` (private
because the overlay is behind the session gate). A new bundle gets a new hash, and `deployment.json`, served
`no-cache`, points at it. The bundled Natural Earth files are hashed by Vite and cached the same way.

Imagery: use Sentinel-2 cloudless **2016** only (later editions are non-commercial). National orthophotos
for close-ups go in through `patchImageryUrl`.

`licensed`: a deployment that holds a licence for a tile source sets `basemap: "licensed"`, `imageryUrl`, its
credit in `credits.imagery`, and `network: true` if the source is remote.
