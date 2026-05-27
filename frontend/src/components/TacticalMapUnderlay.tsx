// =============================================================================
// TacticalMapUnderlay — geographic ground-plane underlay
// =============================================================================
// Renders a north-up equirectangular map at its true geographic bounds,
// projected through the scene's lat/lon -> (x, z) transform. regional
// FOBs naturally end up over the regional portion of the texture; a Korea
// deployment would land over Korea; an Arctic deployment over the Arctic.
// The map doesn't "move" — the projection puts the camera where the FOBs
// are, and that part of the texture renders under them.
//
// Default texture: /map_base.png, a global equirectangular world map
// shipped with the OSS distribution. Lat range -90 to +90, lon range
// -180 to +180. deployment().map can override with a higher-resolution
// regional PNG (different image + tighter bounds) when finer detail
// matters than a globe-scale texture sampled at one region.
//
// Earlier this component had two modes: real-geography (deployment.map
// configured) and decorative-fallback (no deployment.map, slapped a
// 2000x2000 texture at scene origin with no projection). The fallback's
// Africa-shaped continents reading as "assets are over Africa" was a
// BOUNDS bug, not a map bug. With the default bounds applied (the globe
// IS at -90..90, -180..180), the geography lines up automatically. No
// fallback needed; map is always correct.
//
// Standard map-image conventions: north at the top of the image, west at
// the left. The scene projection has north = -Z, west = -X (per
// lib/geoProjection.ts), so a standard north-up PNG plus a -π/2 X rotation
// produces a correctly-oriented underlay. No UV remapping needed.
//
// Resolution note: at regional/HQ camera zooms the visible map area is
// small (regional is ~0.5% of a world map). At a 2k-pixel texture that
// works out to ~50px sampled across the visible camera frustum — readable
// for continents/coastlines, pixelated for road-level detail. If a
// deployment wants road-level detail, override via deployment.map with a
// regional PNG at higher resolution.
import { useTexture } from '@react-three/drei';
import { deployment, type DeploymentMap } from '../deployment';
import type { Projection } from '../lib/geoProjection';

// Global-extent default: the entire equirectangular globe. Works
// correctly for any FOB list anywhere on Earth without further config.
const GLOBAL_MAP_DEFAULT: DeploymentMap = {
  image: '/map_base.png',
  bounds: { lat_min: -90, lat_max: 90, lon_min: -180, lon_max: 180 },
};

interface TacticalMapUnderlayProps {
  /** Scene projection — required. Without it we can't size the plane to
   *  align with FOB/asset positions in the same scene. Callers (HQ +
   *  Regional) always have one. */
  projection: Projection;
}

export default function TacticalMapUnderlay({ projection }: TacticalMapUnderlayProps) {
  const mapCfg = deployment().map ?? GLOBAL_MAP_DEFAULT;
  const texture = useTexture(mapCfg.image);

  // Project the four lat/lon corners into scene space, then size + place
  // the plane to span them. Sign convention from geoProjection.ts: north
  // = -Z, west = -X, so lat_max -> z_min, lon_min -> x_min.
  const [xMinW, zMaxS] = projection.project(mapCfg.bounds.lat_min, mapCfg.bounds.lon_min);
  const [xMaxE, zMinN] = projection.project(mapCfg.bounds.lat_max, mapCfg.bounds.lon_max);
  const width = Math.abs(xMaxE - xMinW);
  const height = Math.abs(zMaxS - zMinN);
  const cx = (xMinW + xMaxE) / 2;
  const cz = (zMinN + zMaxS) / 2;

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -2.1, cz]}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </mesh>
  );
}
