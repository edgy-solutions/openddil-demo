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
//   * deployment().fobs                   — deployment-supplied FOB list
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
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import DdilNetworkLink from '../DdilNetworkLink';
import AssetVisual from '../AssetVisual';
import LogisticsHubNode from '../LogisticsHubNode';
import TacticalMapUnderlay from '../TacticalMapUnderlay';
import { deployment, type Fob } from '../../deployment';
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

// Severity color tables previously lived here. Removed when AssetMarker's
// sphereGeometry was replaced with AssetVisual (Phase 3 of the cascade
// work) — the cascade owns ring color now via its own internal palette
// keyed on both severity AND force_id.

interface RenderableAsset {
  asset_id: string;
  /** [x, y, z] in scene units. */
  position: [number, number, number];
  severity: string;
  /** Drives the AssetVisual cascade. Null/empty -> UnknownPlatformBadge. */
  platform_variant: string | null;
  /** Force affiliation for the AssetVisual base ring (overrides severity
   *  color for FORCE_OPPOSING / FORCE_NEUTRAL entities). */
  force_id: string | null;
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
      severity: sev,
      platform_variant: a.platform_variant,
      force_id: a.force_id,
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
  assetId, position, severity, platformVariant, forceId, selected, onClick,
}: {
  assetId: string;
  position: [number, number, number];
  severity: string;
  platformVariant: string | null;
  forceId: string | null;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  // Hit-target is an invisible sphere sized to roughly match the schematic
  // footprint at SCENE_ASSET_SCALE (~3 units). AssetVisual renders the actual
  // platform silhouette + severity ring; the hit-target lets the operator
  // click anywhere near the asset without having to land precisely on a
  // schematic mesh (especially important for thin radar-dish silhouettes).
  return (
    <group position={position} userData={{ assetId }}>
      <mesh onClick={onClick} visible={false}>
        <sphereGeometry args={[3.5, 8, 8]} />
        <meshBasicMaterial />
      </mesh>
      <AssetVisual
        platformVariant={platformVariant}
        severity={severity}
        forceId={forceId}
        scale={SCENE_ASSET_SCALE}
        selected={selected}
      />
    </group>
  );
}

// Wrapping scale applied to each schematic / GLB inside an AssetVisual.
// Schematics were authored at "single-asset close-up" scale (~5-10 units
// across); regional view has multiple assets in a ~400-unit canvas with
// the camera at ~150 units back. 0.3-0.4 is the starting estimate;
// tune during visual QA.
const SCENE_ASSET_SCALE = 0.35;

// =============================================================================
// Topology nodes — RegionalAggregator + HQ marker
// =============================================================================
// FOB <-> regional aggregator <-> HQ is the real hub-and-spoke OpenDDIL
// implements (per-edge bridges aggregate to a region; regions roll up to HQ).
// These visual elements make that topology readable.
//
// RegionalAggregator and HQ are LOGICAL nodes — they don't have lat/lon in
// the deployment metadata. RegionalAggregator is placed at the centroid of
// the region's FOBs (defensible "logically central to the region"); HQ is
// stacked above the regional centroid (vertical stem reads as "up the
// chain"). Both choices are deployment-configurable extensions for later —
// see ADR-0023 + the project's strategy-resolver discipline for the
// architectural family.
//
// Severance state is read from the same `link1` boolean the rest of the
// view uses (which comes from edge_buffer_status.hq_link_severed). When
// severed, line styling + node coloring shift to red/dashed — matches the
// DdilNetworkLink convention.

const REGIONAL_AGGREGATOR_Y = 8;   // slightly elevated above FOB markers (Y=0)
const HQ_MARKER_Y = 40;             // stacked above the regional aggregator

function RegionalAggregatorNode({ position, label, severed }: {
  position: [number, number, number];
  label: string;
  severed: boolean;
}) {
  const color = severed ? 0xf43f5e : 0x22d3ee;
  return (
    <group position={position}>
      {/* Solid octahedron core — logical node visual. Octahedron is
          deliberately not a shape any FOB or platform schematic uses, so
          it reads as "different category of thing." */}
      <mesh>
        <octahedronGeometry args={[3.5, 0]} />
        <meshBasicMaterial color={color} transparent opacity={0.65} />
      </mesh>
      {/* Wireframe outer shell — gives the node a halo without solidifying */}
      <mesh>
        <octahedronGeometry args={[4.5, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.4} />
      </mesh>
      <Html
        position={[0, 6, 0]}
        center
        style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
      >
        <div className="font-mono text-[10px] tracking-widest text-cyan-200 bg-slate-900/80 border border-slate-700 px-2 py-1 rounded-sm">
          <div className="text-[9px] text-slate-400">REGIONAL AGGREGATOR</div>
          <div className="text-slate-200 font-bold">{label}</div>
        </div>
      </Html>
    </group>
  );
}

function HqMarker({ position, severed }: {
  position: [number, number, number];
  severed: boolean;
}) {
  const color = severed ? 0xf43f5e : 0x10b981;
  return (
    <group position={position}>
      {/* Pyramid form — distinct from FOB hubs and regional octahedron.
          Cone with 4 radial segments approximates a pyramid. */}
      <mesh>
        <coneGeometry args={[5, 10, 4]} />
        <meshBasicMaterial color={color} transparent opacity={0.7} />
      </mesh>
      <mesh>
        <coneGeometry args={[5.5, 10.5, 4]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.4} />
      </mesh>
      <Html
        position={[0, 8, 0]}
        center
        style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
      >
        <div className="font-mono text-[10px] tracking-widest text-emerald-200 bg-slate-900/80 border border-slate-700 px-2 py-1 rounded-sm">
          <div className="text-[9px] text-slate-400">UP-CHAIN</div>
          <div className="text-slate-200 font-bold">HQ THEATER</div>
        </div>
      </Html>
    </group>
  );
}

function CameraRig({ targetPos, isZoomed }: { targetPos: THREE.Vector3 | null, isZoomed: boolean }) {
  const { camera, controls } = useThree();
  useFrame(() => {
    // Only auto-lerp when zoomed to a specific asset. When unzoomed,
    // OrbitControls owns the camera and the user can pan/orbit/zoom freely.
    // Earlier this branch ran every frame regardless, snapping the camera
    // back to default and making it impossible to interact with 100+
    // assets in the AOR. Initial camera position comes from <Canvas
    // camera={{ position: ... }}> on first mount.
    if (isZoomed && targetPos) {
      camera.position.lerp(new THREE.Vector3(targetPos.x + 15, targetPos.y + 10, targetPos.z + 15), 0.05);
      if (controls) {
        (controls as any).target.lerp(new THREE.Vector3(targetPos.x, targetPos.y + 4, targetPos.z), 0.05);
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
  const { fobs } = deployment();

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

  // Regional aggregator position — centroid of the region's FOBs in scene
  // coordinates. Default placement for the logical aggregator node (no
  // lat/lon in deployment metadata today; a future field on the region
  // could override this). Null when no FOBs in the region — the topology
  // overlay simply doesn't render.
  const regionalCentroid = useMemo(() => {
    if (regionFobs.length === 0) return null;
    const lat = regionFobs.reduce((s, f) => s + f.lat, 0) / regionFobs.length;
    const lon = regionFobs.reduce((s, f) => s + f.lon, 0) / regionFobs.length;
    const [x, z] = proj.project(lat, lon);
    return { x, z };
  }, [regionFobs, proj]);

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
            <span className="text-emerald-400">{link1 ? 1 : 0} UP</span>
            {!link1 && (
              <span className="text-rose-400 ml-4">1 DOWN</span>
            )}
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

          {/* Geographic context — real map under the assets when a
              deployment.json map block is configured. Fallback decorative
              ambient when not. Geography matters MORE at AOR scope than at
              HQ (sensor coverage, terrain, towns), per ADR-0017's
              context-honesty discipline. */}
          <TacticalMapUnderlay projection={proj} />

          {/* FOB hub markers — endpoints for the topology lines below.
              Without these, the per-FOB-to-aggregator lines would
              terminate "in midair" at FOB lat/lons (where assets
              cluster) with no visible node. */}
          {regionFobs.map((fob) => {
            const [x, z] = proj.project(fob.lat, fob.lon);
            return (
              <LogisticsHubNode
                key={`hub-${fob.edge_id}`}
                position={[x, 0, z]}
              />
            );
          })}

          {renderables.map((a) => (
            <AssetMarker
              key={a.asset_id}
              assetId={a.asset_id}
              position={a.position}
              severity={a.severity}
              platformVariant={a.platform_variant}
              forceId={a.force_id}
              selected={a.asset_id === selectedAssetId}
              onClick={(e) => { e.stopPropagation(); onAssetSelect(a.asset_id, a.severity); }}
            />
          ))}

          {/* Topology overlay: real OpenDDIL network shape (per-FOB bridge
              -> regional aggregator -> HQ theater).
              ============================================================
              Earlier this view drew one DdilNetworkLink per asset, from a
              fixed origin to each asset's position. That was a category
              error, not just visual chaos: per-asset network links don't
              exist in OpenDDIL's data model (the connection is AMQP ->
              projector -> ElectricSQL, which isn't a per-asset thing).
              Same family as the REGIONS-array and DISCOVERED_FLEET
              removals — abstract visuals making claims the data model
              didn't support.
              The lines below DO represent real topology: FOBs are real
              network endpoints (per-edge bridges), regional aggregators
              are real logical infrastructure, HQ is the up-chain. Link
              state comes from the same edge_buffer_status flag the
              header uses, so severance toggling is consistent across
              the view. Future: per-edge bridge health would let each
              FOB->aggregator line carry its own state independently. */}
          {regionalCentroid && (
            <>
              {regionFobs.map((fob) => {
                const [fx, fz] = proj.project(fob.lat, fob.lon);
                return (
                  <DdilNetworkLink
                    key={`fob-link-${fob.edge_id}`}
                    start={new THREE.Vector3(fx, 0, fz)}
                    end={new THREE.Vector3(regionalCentroid.x, REGIONAL_AGGREGATOR_Y, regionalCentroid.z)}
                    status={link1 ? 'NOMINAL' : 'SEVERED'}
                  />
                );
              })}
              <DdilNetworkLink
                start={new THREE.Vector3(regionalCentroid.x, REGIONAL_AGGREGATOR_Y, regionalCentroid.z)}
                end={new THREE.Vector3(regionalCentroid.x, HQ_MARKER_Y, regionalCentroid.z)}
                status={link1 ? 'NOMINAL' : 'SEVERED'}
              />
              <RegionalAggregatorNode
                position={[regionalCentroid.x, REGIONAL_AGGREGATOR_Y, regionalCentroid.z]}
                label={(regionId ?? '').toUpperCase()}
                severed={!link1}
              />
              <HqMarker
                position={[regionalCentroid.x, HQ_MARKER_Y, regionalCentroid.z]}
                severed={!link1}
              />
            </>
          )}
        </Canvas>
      </div>

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN REGION • [RMB] ROTATE VIEW • [SCROLL] MAGNIFY
      </div>
    </div>
  );
}
