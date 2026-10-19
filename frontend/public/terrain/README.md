# Bundled terrain data

`lakes-10m.json`: Natural Earth 10 m lakes (public domain), v5.1.2, from
https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson

The HQ land mask subtracts these from world-atlas `land-10m`, which counts lakes as land.
The file is converted to quantised TopoJSON in world-atlas's shape, so `decodeLand` reads it:

    node scripts/lakes2topo.mjs ne_10m_lakes.geojson public/terrain/lakes-10m.json
