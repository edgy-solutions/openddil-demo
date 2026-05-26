// =============================================================================
// RegionalSustainmentPosture — regional logistics-tier 3D map
// =============================================================================
// Phase A backend wiring: was DEMO_MOCK with a hardcoded DISCOVERED_FLEET of
// 4 fabricated assets at arbitrary scene coords. Now reads:
//
//   * useFleetAssetsForRegion(regionId)   — assets scoped to the active
//                                            pulldown region.
//   * useAllLogisticsStatus()             — overall_severity per asset, used
//                                            to color the markers.
//   * branding().fobs                     — deployment-supplied FOB list
//                                            (positions + region mapping).
//
// Asset placement:
//   * Asset has a position (kinematics.position.wgs84) -> project lat/lon to
//     scene coords via makeProjection (lib/geoProjection.ts).
//   * Asset has no position (strike-only assets like customer-overlay launchers)
//     -> placed at its assigned FOB's coordinates (lookup by edge_id).
//   * Asset has neither position nor a matching FOB -> dropped from the
//     scene (rendered nowhere — the case shouldn't happen in a healthy
//     deployment but the panel still degrades gracefully).
//
// Phase B (post-Monday eyeball iteration) owns: visual polish, co-located
// asset stacking, per-edge labels, honesty badges, color/style tuning.
// =============================================================================
import { useMemo } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import DdilNetworkLink from '../DdilNetworkLink';
import { branding, type Fob } from '../../branding';
import {
  useFleetAssetsForRegion,
  useAllLogisticsStatus,
  type FleetAsset,
  type LogisticsStatus,
} from '../../hooks';
import { makeProjection, type Projection } from '../../lib/geoProjection';

// Scene scale: ~80 units per degree of latitude puts a regional-sized bbox
// (~3°) at ~240 scene units, fitting comfortably in the ~400-unit canvas
// without crowding the legend or the link source point at z=-80.
const SCENE_SCALE_UNITS_PER_DEG = 80;

// Severity -> Three.js color (matches the regional view's existing palette).
const SEVERITY_COLOR: Record<string, number> = {
  LOGISTICS_SEVERITY_OK:              0x10b981, // emerald
  LOGISTICS_SEVERITY_DEGRADED:        0xf59e0b, // amber
  LOGISTICS_SEVERITY_CRITICAL:        0xf43f5e, // rose
  LOGISTICS_SEVERITY_NON_OPERATIONAL: 0xb91c1c, // dark red
  LOGISTICS_SEVERITY_UNSPECIFIED:     0x64748b, // slate
};
const DEFAULT_COLOR = 0x64748b;

interface RenderableAsset {
  asset_id: string;
  /** [x, y, z] in scene units. */
  position: [number, number, number];
  color: number;
  severity: string;
  /** True if the position came from the asset's FOB instead of from
   *  real telemetry — informational only (Phase B may visually mark it). */
  homedAtFob: boolean;
}

function buildRenderables(
  fleet: FleetAsset[],
  logistics: LogisticsStatus[],
  fobs: Fob[],
  proj: Projection,
): RenderableAsset[] {
  const fobByEdge = new Map(fobs.map((f) => [f.edge_id, f]));
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));

  const out: RenderableAsset[] = [];
  for (const a of fleet) {
    let lat: number | null = null;
    let lon: number | null = null;
    let homed = false;
    if (a.position) {
      lat = a.position.lat;
      lon = a.position.lon;
    } else if (a.edge_id) {
      const fob = fobByEdge.get(a.edge_id);
      if (fob) {
        lat = fob.lat;
        lon = fob.lon;
        homed = true;
      }
    }
    if (lat === null || lon === null) continue;
    const [x, z] = proj.project(lat, lon);
    const sev = sevByAsset.get(a.asset_id) ?? 'LOGISTICS_SEVERITY_UNSPECIFIED';
    out.push({
      asset_id: a.asset_id,
      position: [x, 0, z],
      color: SEVERITY_COLOR[sev] ?? DEFAULT_COLOR,
      severity: sev,
      homedAtFob: homed,
    });
  }
  return out;
}

function Terrain() {
  // Same procedural plane as before — visual context for the markers.
  // No data dependency; runs once at mount.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[400, 400, 30, 30]} />
      <meshStandardMaterial color={0x0f172a} roughness={1.0} flatShading />
    </mesh>
  );
}

function AssetMarker({
  assetId, position, color, selected, onClick,
}: {
  assetId: string;
  position: [number, number, number];
  color: number;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  return (
    <group position={position} userData={{ assetId }}>
      <mesh onClick={onClick}>
        <sphereGeometry args={[2.5, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.2, 0]}>
          <ringGeometry args={[4, 4.6, 32]} />
          <meshBasicMaterial color={0x22d3ee} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

function CameraRig({ targetPos, isZoomed }: { targetPos: THREE.Vector3 | null, isZoomed: boolean }) {
  const { camera, controls } = useThree();
  useFrame(() => {
    if (isZoomed && targetPos) {
      camera.position.lerp(new THREE.Vector3(targetPos.x + 15, targetPos.y + 10, targetPos.z + 15), 0.05);
      if (controls) {
        (controls as any).target.lerp(new THREE.Vector3(targetPos.x, targetPos.y + 4, targetPos.z), 0.05);
      }
    } else {
      camera.position.lerp(new THREE.Vector3(0, 150, 180), 0.05);
      if (controls) {
        (controls as any).target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
      }
    }
  });
  return null;
}

function FogController({ isZoomed }: { isZoomed: boolean }) {
  const { scene } = useThree();
  useFrame(() => {
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, isZoomed ? 0.08 : 0.005, 0.05);
    }
  });
  return null;
}

export default function RegionalSustainmentPosture({
  link1,
  regionId,
  selectedAssetId,
  onAssetSelect,
}: {
  link1: boolean;
  /** Active region pulldown selection; assets and projection are scoped to
   *  this region. Null = no region picked yet (cold start). */
  regionId: string | null;
  selectedAssetId: string | null;
  onAssetSelect: (id: string | null, type: string | null) => void;
}) {
  const fleet = useFleetAssetsForRegion(regionId);
  const logistics = useAllLogisticsStatus();
  const { fobs } = branding();

  // Project around the active region's FOBs so the camera bbox is the
  // region's geographic extent, not the whole theater.
  const regionFobs = useMemo(
    () => (regionId ? fobs.filter((f) => f.region_id === regionId) : fobs),
    [fobs, regionId],
  );
  const proj = useMemo(
    () => makeProjection(regionFobs, SCENE_SCALE_UNITS_PER_DEG),
    [regionFobs],
  );

  const renderables = useMemo(
    () => buildRenderables(fleet.data, logistics.data, fobs, proj),
    [fleet.data, logistics.data, fobs, proj],
  );

  const targetAsset = useMemo(
    () => renderables.find((a) => a.asset_id === selectedAssetId),
    [renderables, selectedAssetId],
  );
  const targetPos = targetAsset ? new THREE.Vector3(...targetAsset.position) : null;

  return (
    <div className="col-span-2 panel flex flex-col relative overflow-hidden">
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start">
        <div>
          <h1 className="glitch-text text-2xl font-bold text-emerald-400">REGIONAL SUSTAINMENT POSTURE</h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400">
            AREA OF RESPONSIBILITY: {(regionId ?? '—').toUpperCase()}
            <span className="ml-3 opacity-60">{renderables.length} ASSET{renderables.length === 1 ? '' : 'S'}</span>
          </p>
        </div>
        <div className="text-right bg-slate-900/80 p-2 border border-slate-700">
          <div className="text-[10px] text-slate-500 mb-1">THEATER LINK STATUS</div>
          {/* One edge->HQ DDIL link in this topology — count kept
              consistent with TheaterReadinessPosture's 1/0. */}
          <div className="text-xl font-bold flex items-center justify-end font-rajdhani">
            <span className="text-emerald-400 mr-4">{link1 ? 1 : 0} UP</span>
            <span className="text-rose-400">{link1 ? 0 : 1} DOWN</span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 bg-emerald-500"></div>
          <span className="text-slate-300">NOMINAL LINK</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-rose-500"></div>
          <span className="text-slate-300">SEVERED LINK</span>
        </div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 150, 180], fov: 40 }} onPointerMissed={() => onAssetSelect(null, null)}>
          <color attach="background" args={[0x020617]} />
          <fogExp2 attach="fog" args={[0x020617, 0.005]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[50, 100, 50]} intensity={1.5} />
          <hemisphereLight groundColor={0x020617} intensity={0.5} />

          <OrbitControls makeDefault enableDamping dampingFactor={0.05} maxDistance={300} minDistance={10} maxPolarAngle={Math.PI / 2 - 0.1} />

          <CameraRig targetPos={targetPos} isZoomed={!!selectedAssetId} />
          <FogController isZoomed={!!selectedAssetId} />

          <gridHelper args={[400, 100, 0x1e293b, 0x0f172a]} position={[0, -2, 0]} />
          <Terrain />

          {renderables.map((a) => (
            <AssetMarker
              key={a.asset_id}
              assetId={a.asset_id}
              position={a.position}
              color={a.color}
              selected={a.asset_id === selectedAssetId}
              onClick={(e) => { e.stopPropagation(); onAssetSelect(a.asset_id, a.severity); }}
            />
          ))}

          {renderables.map((a) => (
            <DdilNetworkLink
              key={`link-${a.asset_id}`}
              start={new THREE.Vector3(0, 0, -80)}
              end={new THREE.Vector3(...a.position)}
              status={link1 ? 'NOMINAL' : 'SEVERED'}
            />
          ))}
        </Canvas>
      </div>

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN REGION • [RMB] ROTATE VIEW • [SCROLL] MAGNIFY
      </div>
    </div>
  );
}
