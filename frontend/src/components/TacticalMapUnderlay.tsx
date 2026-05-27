// =============================================================================
// TacticalMapUnderlay — geographic / decorative ground-plane underlay
// =============================================================================
// Two modes, picked by the deployment overlay:
//
//   * REAL GEOGRAPHY  — when deployment().map is set, loads the deployment-
//                       supplied PNG (e.g. an OSM screenshot of the FOB
//                       region) and SIZES + POSITIONS the plane so its
//                       lat/lon bounds align with the scene's projection.
//                       Texture's geography appears under the assets at
//                       roughly the right place.
//
//   * DECORATIVE      — fallback for the OSS default (no overlay). Loads
//                       /map_base.png at very low opacity so it functions
//                       as ambient terrain noise without claiming to
//                       represent specific geography. (Was 0.15 originally;
//                       dropped to 0.03 once we noticed the texture's
//                       Africa-shaped continents read as a misalignment
//                       when the scene is centered on regional.)
//
// Standard map-image conventions: north at the top of the image, west at
// the left. The scene projection has north = -Z, west = -X (per
// lib/geoProjection.ts), so a standard north-up PNG plus a -π/2 X rotation
// produces a correctly-oriented underlay. No UV remapping needed.
//
// ADR-0017 marker: pure-3D primitive, no DOM banner possible. The
// decorative mode is the DEMO_MOCK case; geo mode is real-data.
import { useTexture } from '@react-three/drei';
import { deployment } from '../deployment';
import type { Projection } from '../lib/geoProjection';

const DEMO_MOCK = true;
void DEMO_MOCK; // decorative-fallback path is the DEMO_MOCK case; geo path is real

interface TacticalMapUnderlayProps {
  /** When provided AND deployment().map is set, the underlay is positioned
   *  + sized to align with the projection's coordinate system. Without a
   *  projection, the component falls back to the decorative texture even
   *  if a deployment map is configured. */
  projection?: Projection;
}

export default function TacticalMapUnderlay({ projection }: TacticalMapUnderlayProps = {}) {
  const dep = deployment();
  const mapCfg = dep.map;

  // Hooks must run unconditionally — load both textures (the geo one if
  // configured, the decorative fallback otherwise). useTexture suspends so
  // the path it gets is what's fetched; we pick the right path here.
  const texturePath = mapCfg && projection ? mapCfg.image : '/map_base.png';
  const texture = useTexture(texturePath);

  if (mapCfg && projection) {
    // Project the four lat/lon corners into scene space, then size + place
    // the plane to span them. Use absolute extents because the projection's
    // sign convention (north=-Z, west=-X) means lat_max -> z_min, lon_min -> x_min.
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

  // Decorative fallback. See header comment for the opacity rationale.
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
