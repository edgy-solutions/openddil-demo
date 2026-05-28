// =============================================================================
// TacticalMapUnderlay — geographic / decorative ground-plane underlay
// =============================================================================
// Three modes, picked by what's configured:
//
//   * REAL GEOGRAPHY  — when deployment().map is set, loads the deployment-
//                       supplied regional PNG (e.g. an OSM screenshot of the
//                       FOB region) and projects its lat/lon bounds through
//                       the scene projection so geography lines up with
//                       assets. opacity 0.55, white. (bb824ed verbatim.)
//
//   * AUTO-LOCATED    — when no deployment.map but a projection AND FOBs
//                       are available: load the default /map_base.png world
//                       map, compute a FOB bbox + small buffer, project to
//                       scene coords for plane size+position, AND UV-remap
//                       the texture so the bbox region of the world texture
//                       is sampled. The resulting plane is small (no
//                       globe-scale strobing), in the right place (centered
//                       on the FOB cluster via the projection), with the
//                       right geography under the assets (via UV remap).
//                       Material is the decorative-path material verbatim
//                       (opacity 0.03, color #10b981) — operator confirmed
//                       this is the look they want.
//
//   * DECORATIVE      — final fallback (no projection passed): 2000x2000
//                       plane at scene origin, opacity 0.03, color #10b981.
//                       Unprojected, so the texture's geographic center
//                       (lat=0, lon=0 ≈ mid-Atlantic) lands at scene
//                       origin. Cold-start only; callers all pass
//                       projection in practice.
//
// Why three modes instead of just collapsing into one: the AUTO-LOCATED
// path replaces the historical decorative-stretches-Africa-over-regional
// path while reusing the same material. The REAL GEOGRAPHY path stays
// for deployments that have sourced a regional high-res PNG and want
// the higher-opacity geography idiom. The DECORATIVE path stays only as
// a no-projection safety net.
//
// Standard map-image conventions: north at the top of the image, west at
// the left. The scene projection has north = -Z, west = -X (per
// lib/geoProjection.ts), so a standard north-up PNG plus a -π/2 X rotation
// produces a correctly-oriented underlay.
//
// Texture UV math: an equirectangular world map has u=(lon+180)/360 from
// west to east, v=(lat+90)/180 from south to north. THREE.Texture.offset
// is the UV origin (lower-left of the visible region), and .repeat is
// the size of the visible region. So sampling lat in [lat_min, lat_max]
// and lon in [lon_min, lon_max] means:
//   offset = ((lon_min+180)/360, (lat_min+90)/180)
//   repeat = ((lon_max-lon_min)/360, (lat_max-lat_min)/180)
//
// ADR-0017 marker: pure-3D primitive, no DOM banner possible. The
// decorative + auto-located modes are the DEMO_MOCK case; geo mode is real-data.
import { useTexture } from '@react-three/drei';
import { deployment, type Fob } from '../deployment';
import type { Projection } from '../lib/geoProjection';

const DEMO_MOCK = true;
void DEMO_MOCK; // decorative + auto-located paths are DEMO_MOCK; geo path is real

// Buffer (degrees) added on each side of the FOB bbox so the map extends a
// little beyond the assets — provides geographic context without globe scale.
// 2° at regional scale ≈ 220km of map past the last FOB on each side.
const FOB_BBOX_BUFFER_DEG = 2;

interface TacticalMapUnderlayProps {
  /** When provided AND deployment().map is set, the underlay is positioned
   *  + sized to align with the projection's coordinate system. When provided
   *  WITHOUT deployment().map, the underlay auto-locates around the FOB bbox
   *  and UV-remaps the default world texture. Without a projection, falls
   *  back to the unprojected decorative plane at scene origin. */
  projection?: Projection;
}

function computeFobBounds(fobs: Fob[], buffer: number) {
  const lats = fobs.map((f) => f.lat);
  const lons = fobs.map((f) => f.lon);
  return {
    lat_min: Math.min(...lats) - buffer,
    lat_max: Math.max(...lats) + buffer,
    lon_min: Math.min(...lons) - buffer,
    lon_max: Math.max(...lons) + buffer,
  };
}

export default function TacticalMapUnderlay({ projection }: TacticalMapUnderlayProps = {}) {
  const dep = deployment();
  const mapCfg = dep.map;
  const fobs = dep.fobs;

  // Hooks must run unconditionally — pick texture path here based on
  // whether the deployment supplied a regional override.
  const texturePath = mapCfg && projection ? mapCfg.image : '/map_base.png';
  const texture = useTexture(texturePath);

  // REAL GEOGRAPHY — bb824ed verbatim. Deployment supplied a regional
  // PNG with lat/lon bounds; the projection sizes and places it.
  if (mapCfg && projection) {
    const [xMinW, zMaxS] = projection.project(mapCfg.bounds.lat_min, mapCfg.bounds.lon_min);
    const [xMaxE, zMinN] = projection.project(mapCfg.bounds.lat_max, mapCfg.bounds.lon_max);
    const width = Math.abs(xMaxE - xMinW);
    const height = Math.abs(zMaxS - zMinN);
    const cx = (xMinW + xMaxE) / 2;
    const cz = (zMinN + zMaxS) / 2;

    // Reset UV in case this texture was previously remapped (defensive —
    // useTexture caches by URL, and the regional image's full extent IS
    // mapCfg.bounds so no remap is wanted).
    texture.offset.set(0, 0);
    texture.repeat.set(1, 1);

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

  // AUTO-LOCATED — no deployment.map but we have projection + FOBs. Size
  // and place the plane to the FOB bbox (small, ~3°x3° at regional ≈
  // 240x240 scene units at HQ scale) and UV-remap the world texture to
  // sample only that bbox region.
  if (projection && fobs.length > 0) {
    const bounds = computeFobBounds(fobs, FOB_BBOX_BUFFER_DEG);
    const [xMinW, zMaxS] = projection.project(bounds.lat_min, bounds.lon_min);
    const [xMaxE, zMinN] = projection.project(bounds.lat_max, bounds.lon_max);
    const width = Math.abs(xMaxE - xMinW);
    const height = Math.abs(zMaxS - zMinN);
    const cx = (xMinW + xMaxE) / 2;
    const cz = (zMinN + zMaxS) / 2;

    // Equirectangular UV remap — sample only the bbox region of the
    // global texture. See header comment for the formula.
    texture.offset.set((bounds.lon_min + 180) / 360, (bounds.lat_min + 90) / 180);
    texture.repeat.set((bounds.lon_max - bounds.lon_min) / 360, (bounds.lat_max - bounds.lat_min) / 180);

    return (
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -2.1, cz]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={texture}
          transparent
          opacity={0.03}
          color="#10b981"
          depthWrite={false}
        />
      </mesh>
    );
  }

  // DECORATIVE fallback — bb824ed verbatim. Reached only when no
  // projection is provided (cold start; callers do all pass one).
  // Reset UV in case auto-located path mutated the cached texture.
  texture.offset.set(0, 0);
  texture.repeat.set(1, 1);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.1, 0]}>
      <planeGeometry args={[2000, 2000]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={0.03}
        color="#10b981"
        depthWrite={false}
      />
    </mesh>
  );
}
