# Bundled terrain data

`lakes-10m.json`: Natural Earth 10 m lakes (public domain), v5.1.2, from
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson

The HQ land mask subtracts these from world-atlas `land-10m`, which counts lakes as land.
The file is converted to quantised TopoJSON in world-atlas's shape, so `decodeLand` reads it:

    node scripts/lakes2topo.mjs ne_10m_lakes.geojson public/terrain/lakes-10m.json

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
| `landUrl` | `/terrain/land-10m.json` | Natural Earth land (coast mask). |
| `lakesUrl` | `/terrain/lakes-10m.json` | Natural Earth lakes, cut out of the land. |
| `waterUrl` | `/deployment-overlay/terrain/water.json` | OSM sea polygons; used in place of the land file when present. |
| `reliefPalette` | `sand` | `sand` or `slate` (dark). |
| `credits` | see below | Per-source credit lines: `elevation`, `imagery`, `patchImagery`, `land`, `water`. |

`network: false` is the default: a remote URL in any URL key is refused with a console warning and the
packaged default is used instead. A source on another host needs `network: true`.

Data is packaged in the deployment overlay, which nginx serves at `/deployment-overlay/` (404 when absent):

    /deployment-overlay/terrain/dem/{z}/{x}/{y}.png
    /deployment-overlay/terrain/imagery/{z}/{x}/{y}.jpg
    /deployment-overlay/terrain/water.json

DEM zooms needed: up to z11 for the heightfield and up to z13 for the relief texture of the regional AOI;
the HQ surround uses z7.

`water.json` (optional, ODbL credit required) comes from the OSM water polygons dataset
(osmdata.openstreetmap.de, "water-polygons-split-4326"), clipped to the AOI:

    ogr2ogr -clipsrc <w> <s> <e> <n> water.json water_polygons.shp -f GeoJSON

It is read as a GeoJSON FeatureCollection of Polygon/MultiPolygon in lon/lat, or as TopoJSON.

Imagery: use Sentinel-2 cloudless **2016** only (later editions are non-commercial). National orthophotos
for close-ups go in through `patchImageryUrl`.

`licensed`: a deployment that holds a licence for a tile source sets `basemap: "licensed"`, `imageryUrl`, its
credit in `credits.imagery`, and `network: true` if the source is remote.

`land-10m.json` (world-atlas 2.0.2, Natural Earth, public domain) is expected in this folder; until it is
added the coast mask is skipped.
