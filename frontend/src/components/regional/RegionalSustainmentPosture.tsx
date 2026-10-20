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
// Assets sit at their true positions, on the terrain when it is on and on the
// flat ground when it is off. Symbols are scaled each frame to a constant size
// on screen, never below true size. Co-located assets (a FOB, or a bucket of
// nearby assets) draw as one symbol per kind until the camera is close enough
// for them to clear each other. See lib/symbolScale.ts and lib/clusterKinds.ts.
//
// Phase B remaining: per-edge labels, honesty badges, color/style tuning.
// =============================================================================
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import DdilNetworkLink from '../DdilNetworkLink';
import AssetVisual from '../AssetVisual';
import LogisticsHubNode from '../LogisticsHubNode';
import { LinkChips } from '../network/LinkChips';
import { PostureHeader } from '../PostureHeader';
import { deployment, moveInputs, type Fob } from '../../deployment';
import { buildMunitionsLedger } from '../../lib/munitionsLedger';
import { calloutAmmo } from '../../lib/calloutAmmo';
import { usePostureClock } from '../../lib/posture';
import {
  useFleetAssetsForRegion,
  useAllLogisticsStatus,
  useAllCapabilityState,
  useFleetTiers,
  useMunitionsStockpile,
  useAllEffectorLaunches,
  useAllEffectorResupply,
  useInFlightMunitionTracks,
  useMunitionTrackFeed,
  useEdgeBuffer,
  useLinkStatus,
  type FleetAsset,
  type FleetTierMap,
  type LogisticsStatus,
  type OperationalState,
} from '../../hooks';
import { makeAssetClassifier } from '../../lib/assetClass';
import { useMunitionLaunches } from '../../hooks/useEffectorLaunches';
import { isTierVisibleIn3D, type AssetTier } from '../../lib/assetTier';
import { makeProjection, type Projection } from '../../lib/geoProjection';
import { trackLatLon } from '../../lib/munitionTrackLayout';
import MunitionTrackHolo, { CURTAIN_MAX_TRACKS, type Vec3 } from '../MunitionTrackHolo';
import { useMunitionTrails } from '../../hooks/useMunitionTrails';
import EngagementInset, { EngagementInsetFrame, type InsetMarker } from '../EngagementInset';
import { INSET_RECT, clearOfGround, engagementFocus, frameOf, gridStepKm, heightAboveLaunch } from '../../lib/engagementFrame';
import { M, SCENE_SCALE_UNITS_PER_DEG, UNITS_PER_KM } from '../../lib/sceneScale';
import { symbolRadius, worldPerPx } from '../../lib/symbolScale';
import { separate } from '../../lib/separate';
import { AGG_PX, FOB_PX, HQ_PX, markerScale, regionExtent, stackLift, topologyHeights } from '../../lib/topologyMarkers';
import { SEV_RANK, fogDensity, fogVisibility, groupsOf, kindsOf, mstEdges, nextMerged, type Kind } from '../../lib/clusterKinds';
import { assetFocus, buildPresets, controlsMaxDistance, type CameraPreset } from '../../lib/mapPresets';
import { distanceKm, formatKm, framedRect, planTopology, resolveSites, sameSite } from '../../lib/regionalSites';
import { snapBounds, terrainBounds } from '../../lib/terrainBounds';
import { creditLines, resolveTerrainSource } from '../../lib/terrainTiles';
import { TerrainMesh, PatchMesh } from '../terrain/terrain';
import { usePatches, useTerrain, type PatchSpec } from '../terrain/terrainData';
import { ViewTiles } from '../terrain/ViewTiles';
import { tileBoxBounds, type TileBox } from '../../lib/viewTiles';
import { HoloPanel, HoloTerrain } from '../terrain/holo';
import { RegionalSurround } from '../terrain/theater';
import { edgeRamp } from '../terrain/theaterShaders';
import { HQ_SCALE, surroundBounds, useMask, useSurround, type Rect } from '../terrain/theaterData';
import { screenArrowDeg } from '../../lib/screenArrow';
import type { HoloOpts } from '../terrain/holoOpts';
import {
  EXAGGERATIONS, SAT_BRIGHTNESS_MAX, SAT_BRIGHTNESS_MIN, loadTerrainPrefs, saveTerrainPrefs, type Exaggeration, type TerrainPrefs, type TerrainStyle,
} from '../terrain/prefs';
import { segBtn, styleLabel } from '../terrain/segBtn';

// Severity color tables previously lived here. Removed when AssetMarker's
// sphereGeometry was replaced with AssetVisual (Phase 3 of the cascade
// work) — the cascade owns ring color now via its own internal palette
// keyed on both severity AND force_id.

interface RenderableAsset {
  asset_id: string;
  /** Declared callsign (FleetAsset.callsign). Drives the callout's
   *  short-name label in place of asset_id slicing — see
   *  assetShortName below. */
  callsign: string | null;
  /** [x, y, z] in scene units: the asset's true position, y on the ground. */
  position: [number, number, number];
  /** The lat/lon behind `position` (the FOB's when homedAtFob). */
  lat: number;
  lon: number;
  severity: string;
  /** Drives the AssetVisual cascade. Null/empty -> UnknownPlatformBadge. */
  platform_variant: string | null;
  /** Same as platform_variant: the name lib/clusterKinds groups by. */
  variant: string | null;
  /** Force affiliation for the AssetVisual base ring (overrides severity
   *  color for FORCE_OPPOSING / FORCE_NEUTRAL entities). */
  force_id: string | null;
  /** True if the position came from the asset's FOB instead of from
   *  real telemetry — informational only (Phase B may visually mark it). */
  homedAtFob: boolean;
  /** Phase 5: per-asset operational_state surfaced to the schematic so it
   *  can react to POWER_STATE_OFF / MAINTENANCE / HEALTH_STATE_FAULT etc.
   *  beyond the rolled-up severity-driven `degraded` boolean. */
  operational_state: OperationalState;
  /** Liveness tier (5-state model — see lib/assetTier). Drives the
   *  per-asset ring color override (slate for STALE, amber for COMM_LOST)
   *  + opacity damping so receding assets visibly recede. LOST assets are
   *  filtered out before this struct is built. */
  tier: AssetTier;
}

/** Assets that share a place: one FOB (edge_id), or else one geometric bucket. */
interface RenderCluster {
  key: string;
  /** FOB name, else its edge_id, else "GROUP n". */
  label: string;
  /** Sorted by variant then asset_id so the layout is stable across row reorders. */
  members: RenderableAsset[];
  /** Mean lat/lon of the members. */
  lat: number;
  lon: number;
}

import { colocationBucketKey } from '../../lib/coLocationLayout';
import { resolveRingRadius } from '../../lib/assetGeometry';
import { assetCallsign } from '../../lib/assetLabel';
import { useLinkIndicator } from '../../hooks/useLinkIndicator';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';
import {
  classifyLink,
  summarizeLinks,
  type LinkReading,
} from '../../lib/linkStatus';

type GroundFn = (x: number, z: number) => number;

/** The engagement inset, lifted clear of the terrain controls under it. */
const REGIONAL_INSET_RECT = { ...INSET_RECT, y: INSET_RECT.y + 36 };

/** Every asset at its true position (on `ground`), plus the clusters they bucket into. */
// Exported for tests.
// eslint-disable-next-line react-refresh/only-export-components
export function buildRenderables(
  fleet: FleetAsset[],
  logistics: LogisticsStatus[],
  fobs: Fob[],
  proj: Projection,
  tiers: FleetTierMap,
  ground: GroundFn,
): { renderables: RenderableAsset[]; clusters: RenderCluster[] } {
  const fobByEdge = new Map(fobs.map((f) => [f.edge_id, f]));
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));

  const renderables: RenderableAsset[] = [];
  const buckets = new Map<string, RenderableAsset[]>();
  for (const a of fleet) {
    // LOST tier: hide from the 3D scene entirely. Still in postgres /
    // still in the fleet pulldown for forensics; just out of the
    // perf-sensitive WebGL render path. This is what makes the 2k+-
    // assets-accumulated-across-sessions case viable.
    const tier = tiers.get(a.asset_id) ?? 'ACTIVE';
    if (!isTierVisibleIn3D(tier)) continue;

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
    const r: RenderableAsset = {
      asset_id: a.asset_id,
      callsign: a.callsign,
      position: [x, ground(x, z), z],
      lat,
      lon,
      severity: sevByAsset.get(a.asset_id) ?? 'LOGISTICS_SEVERITY_UNSPECIFIED',
      platform_variant: a.platform_variant,
      variant: a.platform_variant,
      force_id: a.force_id,
      homedAtFob: homed,
      operational_state: a.operational_state,
      tier,
    };
    renderables.push(r);

    // Bucket friendly assets by edge_id (FOB attribution) when known: a FOB is a logical
    // grouping, and its assets' raw positions can span several world units.
    // The geometric bucket is the fallback for assets without an edge_id.
    const tracked = a.force_id !== 'FORCE_OPPOSING' && a.force_id !== 'FORCE_NEUTRAL';
    const key = a.edge_id && tracked ? `edge:${a.edge_id}` : colocationBucketKey(x, z);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(r);
  }

  const clusters: RenderCluster[] = [];
  let groups = 0;
  for (const [key, members] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    members.sort((a, b) => {
      const va = (a.platform_variant ?? '') + a.asset_id;
      const vb = (b.platform_variant ?? '') + b.asset_id;
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    const edge = key.startsWith('edge:') ? key.slice('edge:'.length) : null;
    const label = edge ? (fobByEdge.get(edge)?.label ?? edge) : `GROUP ${++groups}`;
    clusters.push({
      key,
      label,
      members,
      lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
      lon: members.reduce((s, m) => s + m.lon, 0) / members.length,
    });
  }
  return { renderables, clusters };
}

function Terrain() {
  // The terrain-off ground: a dark plane, with a grid on top. No data
  // dependency; runs once at mount.
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[400, 400, 30, 30]} />
        <meshStandardMaterial color={0x0f172a} roughness={1.0} flatShading />
      </mesh>
      <gridHelper args={[400, 100, 0x1e293b, 0x0f172a]} position={[0, -2, 0]} />
    </>
  );
}

// -----------------------------------------------------------------------------
// Symbols, drawn per frame
// -----------------------------------------------------------------------------
// Each asset (or each kind of a clustered group) is a group scaled every frame
// so its base ring is PX_R pixels on screen, never smaller than true size
// (lib/symbolScale.ts). `offsets` is where a clustered symbol is drawn relative
// to the asset's true position; tracks read it so a flight leaves the symbol.

const offsets = new Map<string, THREE.Vector3>();
function offsetOf(id: string): THREE.Vector3 {
  let v = offsets.get(id);
  if (!v) {
    v = new THREE.Vector3();
    offsets.set(id, v);
  }
  return v;
}

const fovOf = (camera: THREE.Camera) => (camera as THREE.PerspectiveCamera).fov ?? 40;
/** Scale of a model authored at ring radius resolveRingRadius(variant, 1), so its ring is the symbol radius. */
const modelScale = (variant: string | null, rSym: number) => rSym / resolveRingRadius(variant, 1);

interface CalloutInfo {
  name: string;
  family: string;
  ammoText: string | null;
  launcherDepleted: boolean;
}

// A soft dark disc under a symbol, so it reads on bright ground: opaque to 0.6 of the radius, then falling to 0.
let haloAlpha: THREE.CanvasTexture | null = null;
function haloAlphaMap(): THREE.CanvasTexture | null {
  if (haloAlpha) return haloAlpha;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null; // no 2D canvas (a test DOM): the disc is a flat tint
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.6, '#fff');
  g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  haloAlpha = new THREE.CanvasTexture(c);
  return haloAlpha;
}

/** Flat contrast disc on the ground at the model's origin, in the model's own units. Takes no clicks. */
function GroundHalo({ variant }: { variant: string | null }) {
  const r = 1.6 * resolveRingRadius(variant, 1);
  const alphaMap = useMemo(() => haloAlphaMap(), []);
  return (
    <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={30} raycast={() => null}>
      <circleGeometry args={[r, 48]} />
      <meshBasicMaterial
        color="#020617" transparent opacity={0.6} alphaMap={alphaMap} depthWrite={false}
        polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4}
      />
    </mesh>
  );
}

function Model({ a, sev, selected }: { a: RenderableAsset; sev?: string; selected?: boolean }) {
  return (
    <>
    <GroundHalo variant={a.platform_variant} />
    <AssetVisual
      platformVariant={a.platform_variant}
      severity={sev ?? a.severity}
      forceId={a.force_id}
      scale={1}
      selected={selected}
      operationalState={a.operational_state}
      tier={a.tier}
    />
    </>
  );
}

/** An invisible click target of radius 1.4 symbol radii, in the model's own units, so a
 *  small or thin model is still easy to hit. The click handler sits on the group holding
 *  it and the model, so the model's own meshes are targets too. */
function HitSphere({ variant }: { variant: string | null }) {
  const r = resolveRingRadius(variant, 1);
  return (
    <mesh visible={false} position={[0, 0.8 * r, 0]}>
      <sphereGeometry args={[1.4 * r, 8, 8]} />
      <meshBasicMaterial />
    </mesh>
  );
}

/** One asset at its true position. */
function AssetMarker({
  asset, selected, callout, onClick,
}: {
  asset: RenderableAsset;
  selected: boolean;
  callout: CalloutInfo | null;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const g = useRef<THREE.Group>(null);
  const { size } = useThree();
  const at = useMemo(() => new THREE.Vector3(...asset.position), [asset.position]);
  useFrame(({ camera }) => {
    if (!g.current) return;
    g.current.scale.setScalar(
      modelScale(asset.platform_variant, symbolRadius(camera.position.distanceTo(at), size.height, fovOf(camera))),
    );
    offsetOf(asset.asset_id).set(0, 0, 0);
  });
  return (
    <group ref={g} position={asset.position} userData={{ assetId: asset.asset_id, insetHidden: true }}>
      <group onClick={onClick}>
        <HitSphere variant={asset.platform_variant} />
        <Model a={asset} selected={selected} />
      </group>
      {callout && (
        <ZoomGate>
          <AssetCallout {...callout} />
        </ZoomGate>
      )}
    </group>
  );
}

const SEV_CHIP: Record<number, string> = {
  0: 'border-cyan-400/60 text-cyan-200', 1: 'border-amber-400/70 text-amber-200',
  2: 'border-rose-500/80 text-rose-200', 3: 'border-rose-500/80 text-rose-200',
};
/** Fades a chip with the scene fog, as a model fades: DOM overlays are not fogged by three. */
function useFogFade() {
  const g = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  const wp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, scene }) => {
    if (!g.current || !el.current) return;
    g.current.getWorldPosition(wp);
    const density = scene.fog instanceof THREE.FogExp2 ? scene.fog.density : 0;
    const v = fogVisibility(density, camera.position.distanceTo(wp));
    el.current.style.opacity = String(v);
    el.current.style.visibility = v < 0.05 ? 'hidden' : 'visible';
  });
  return { g, el };
}

function CountChip({ text, sev }: { text: string; sev: number }) {
  const { g, el } = useFogFade();
  return (
    <group ref={g}>
      <Html center style={{ pointerEvents: 'none', transform: 'translate3d(-50%,calc(-50% - 34px),0)' }}>
        <div ref={el} className={`whitespace-nowrap rounded-full border bg-slate-900/90 px-1.5 font-mono text-[10px] font-bold ${SEV_CHIP[sev] ?? SEV_CHIP[0]}`}>
          {text}
        </div>
      </Html>
    </group>
  );
}

/** The off-map HQ marker: a plate at the map border giving the distance and bearing; a button when it can open HQ. */
function HqChip({ km, bearing, from, at, onOpen }: {
  km: number; bearing: number; onOpen?: () => void;
  /** World points of the link: the regional node's ground point and the chip's own (the exit). */
  from: THREE.Vector3; at: THREE.Vector3;
}) {
  const { g, el } = useFogFade();
  // The arrow turns to run along the link on screen as the camera moves; set through a ref, not React state.
  const arrow = useRef<HTMLSpanElement>(null);
  const lastDeg = useRef(Number.NaN);
  const pf = useMemo(() => new THREE.Vector3(), []);
  const pt = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    if (!arrow.current) return;
    pf.copy(from).project(camera);
    pt.copy(at).project(camera);
    const deg = screenArrowDeg(pf, pt);
    if (Number.isFinite(lastDeg.current) && Math.abs(deg - lastDeg.current) < 1) return;
    lastDeg.current = deg;
    arrow.current.style.transform = `rotate(${deg}deg)`;
  });
  const label = `HQ · ${formatKm(km)} `;
  const text = <>{label}<span ref={arrow} style={{ display: 'inline-block' }}>→</span></>;
  const name = `HQ, ${formatKm(km)}, bearing ${Math.round(bearing)}°`;
  const cls = 'whitespace-nowrap rounded-sm bg-slate-950/75 px-1.5 py-0.5 font-mono text-[10px] text-slate-300';
  return (
    <group ref={g}>
      <Html center style={{ pointerEvents: onOpen ? 'auto' : 'none' }}>
        <div ref={el}>
          {onOpen ? (
            <button type="button" data-testid="hq-chip" title={name} aria-label={name} onClick={onOpen} className={`${cls} cursor-pointer hover:text-emerald-300`}>{text}</button>
          ) : (
            <span data-testid="hq-chip" title={name} aria-label={name} className={cls}>{text}</span>
          )}
        </div>
      </Html>
    </group>
  );
}

/** The "+N" chip for kinds past the cap; click selects a hidden member, again steps to the next. */
function MoreChip({ text, sev, title, onClick }: { text: string; sev: number; title: string; onClick: () => void }) {
  const { g, el } = useFogFade();
  return (
    <group ref={g}>
      <Html center style={{ pointerEvents: 'none' }}>
        <div
          ref={el}
          className={`cursor-pointer whitespace-nowrap rounded-sm border bg-slate-900/90 px-1 font-mono text-[10px] font-bold ${SEV_CHIP[sev]}`}
          style={{ pointerEvents: 'auto' }}
          title={title}
          onClick={(e) => { e.stopPropagation(); onClick(); }}
        >
          {text}
        </div>
      </Html>
    </group>
  );
}

/** One place's members: one symbol per kind (with a count) side by side at their centroid. */
function KindsCluster({
  members, selectedAssetId, onSelect,
}: {
  members: RenderableAsset[];
  selectedAssetId: string | null;
  onSelect: (id: string, severity: string) => void;
}) {
  const centroid = useMemo(() => {
    const c = new THREE.Vector3();
    for (const a of members) c.add(new THREE.Vector3(...a.position));
    return c.divideScalar(members.length);
  }, [members]);
  const { shown, hidden } = useMemo(() => kindsOf(members), [members]);
  // One anchor per slot (each shown kind, then the "+N" chip): the mean of its members.
  const anchors = useMemo(() => {
    const mean = (ms: RenderableAsset[]) => {
      const c = new THREE.Vector3();
      for (const a of ms) c.add(new THREE.Vector3(...a.position));
      return c.divideScalar(Math.max(1, ms.length));
    };
    const out = shown.map((k) => mean(k.members));
    if (hidden.length) out.push(mean(hidden.flatMap((k) => k.members)));
    return out;
  }, [shown, hidden]);
  const slotRefs = useRef<(THREE.Group | null)[]>([]);
  const modelRefs = useRef<(THREE.Group | null)[]>([]);
  const { size } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const leaders = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({ color: '#64748b', transparent: true, opacity: 0.6, depthWrite: false });
    return Array.from({ length: 8 }, () => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      line.userData.insetHidden = true;
      return line;
    });
  }, []);
  useEffect(() => () => {
    (leaders[0].material as THREE.Material).dispose();
    for (const l of leaders) l.geometry.dispose();
  }, [leaders]);

  useFrame(({ camera }) => {
    const rSym = symbolRadius(camera.position.distanceTo(centroid), size.height, fovOf(camera));
    // Symbol radius on screen as drawn (PX_R, or larger when the true-size floor applies).
    const symPx = rSym / worldPerPx(camera.position.distanceTo(centroid), size.height, fovOf(camera));
    const px = anchors.map((a) => {
      const v = a.clone().project(camera);
      return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height] as [number, number];
    });
    const moved = separate(px, 2.2 * symPx);
    const pos = anchors.map((a, i) => {
      if (Math.hypot(moved[i][0] - px[i][0], moved[i][1] - px[i][1]) < 0.5) return a;
      plane.constant = -a.y;
      raycaster.setFromCamera(
        new THREE.Vector2((moved[i][0] / size.width) * 2 - 1, 1 - (moved[i][1] / size.height) * 2), camera);
      return raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? a;
    });
    // Each member's flights leave the symbol for its kind.
    const follow = (k: Kind<RenderableAsset>, p: THREE.Vector3) => {
      for (const a of k.members) offsetOf(a.asset_id).copy(p).sub(new THREE.Vector3(...a.position));
    };
    shown.forEach((k, i) => {
      slotRefs.current[i]?.position.copy(pos[i]);
      modelRefs.current[i]?.scale.setScalar(modelScale(k.variant, rSym));
      follow(k, pos[i]);
    });
    if (hidden.length) {
      const i = shown.length;
      slotRefs.current[i]?.position.copy(pos[i]);
      for (const k of hidden) follow(k, pos[i]);
    }
    // A thin ground leader from a displaced slot back to its true place.
    leaders.forEach((line, i) => {
      const displaced = i < pos.length && pos[i].distanceTo(anchors[i]) > 0.6 * rSym;
      line.visible = displaced;
      if (!displaced) return;
      const at = line.geometry.getAttribute('position');
      at.setXYZ(0, pos[i].x, anchors[i].y, pos[i].z);
      at.setXYZ(1, anchors[i].x, anchors[i].y, anchors[i].z);
      at.needsUpdate = true;
    });
  });

  const hiddenN = hidden.reduce((n, k) => n + k.members.length, 0);
  const hiddenSev = Math.max(0, ...hidden.map((k) => SEV_RANK[k.sev] ?? 0));
  // Click selects the kind's first member; clicking again steps to the next.
  const pick = (k: Kind<RenderableAsset>) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = k.members.findIndex((m) => m.asset_id === selectedAssetId);
    const next = k.members[(i + 1) % k.members.length];
    onSelect(next.asset_id, next.severity);
  };
  const pickHidden = () => {
    const all = hidden.flatMap((k) => k.members);
    if (!all.length) return;
    const i = all.findIndex((m) => m.asset_id === selectedAssetId);
    const next = all[(i + 1) % all.length];
    onSelect(next.asset_id, next.severity);
  };
  return (
    <>
      {shown.map((k, i) => (
        <group
          key={k.variant ?? ''}
          ref={(el) => { slotRefs.current[i] = el; }}
          position={anchors[i]}
          userData={{ insetHidden: true }}
        >
          <group ref={(el) => { modelRefs.current[i] = el; }} onClick={pick(k)}>
            <HitSphere variant={k.variant} />
            <Model a={k.members[0]} sev={k.sev} selected={k.members.some((m) => m.asset_id === selectedAssetId)} />
          </group>
          {k.members.length > 1 && <CountChip text={`×${k.members.length}`} sev={SEV_RANK[k.sev] ?? 0} />}
        </group>
      ))}
      {hidden.length > 0 && (
        <group
          ref={(el) => { slotRefs.current[shown.length] = el; }}
          position={anchors[shown.length]}
          userData={{ insetHidden: true }}
        >
          <MoreChip
            text={`+${hiddenN}`}
            sev={hiddenSev}
            title={hidden.map((k) => `${k.variant} ×${k.members.length}`).join(', ')}
            onClick={pickHidden}
          />
        </group>
      )}
      {leaders.map((l, i) => <primitive key={`lead${i}`} object={l} />)}
    </>
  );
}

/**
 * A bucket's members grouped by place: members whose nearest neighbours (a minimum
 * spanning tree) clear each other on screen are drawn singly, the rest as one
 * kinds-cluster per place. An edge's merge state has hysteresis (kept by asset-id pair,
 * so it survives the members array being rebuilt on each poll).
 */
function ClusterGroup({
  members, selectedAssetId, onSelect, calloutOf,
}: {
  members: RenderableAsset[];
  selectedAssetId: string | null;
  onSelect: (id: string, severity: string) => void;
  calloutOf: (a: RenderableAsset) => CalloutInfo;
}) {
  const mst = useMemo(() => mstEdges(members.map((a) => [a.position[0], a.position[2]])), [members]);
  const mids = useMemo(
    () => mst.map((e) => new THREE.Vector3(...members[e.a].position).add(new THREE.Vector3(...members[e.b].position)).multiplyScalar(0.5)),
    [mst, members],
  );
  const keys = useMemo(
    () => mst.map((e) => [members[e.a].asset_id, members[e.b].asset_id].sort().join('|')),
    [mst, members],
  );
  const state = useRef(new Map<string, boolean>());
  const [sig, setSig] = useState('');
  const { size } = useThree();

  useFrame(({ camera }) => {
    if (members.length < 2) return;
    const fov = fovOf(camera);
    const merged = state.current;
    let next = '';
    for (let i = 0; i < mst.length; i++) {
      const rSym = symbolRadius(camera.position.distanceTo(mids[i]), size.height, fov);
      const m = nextMerged(merged.get(keys[i]), mst[i].len, rSym);
      merged.set(keys[i], m);
      if (m) next += keys[i] + ';';
    }
    if (next !== sig) setSig(next);
  });

  const marker = (a: RenderableAsset) => (
    <AssetMarker
      key={a.asset_id}
      asset={a}
      selected={a.asset_id === selectedAssetId}
      callout={calloutOf(a)}
      onClick={(e) => { e.stopPropagation(); onSelect(a.asset_id, a.severity); }}
    />
  );
  if (members.length < 2) return <>{members.map(marker)}</>;
  const on = new Set(sig.split(';').filter(Boolean));
  const groups = groupsOf(members.length, mst, keys.map((k) => on.has(k)));
  return (
    <>
      {groups.map((g) => {
        if (g.length === 1) return marker(members[g[0]]);
        const ms = g.map((i) => members[i]);
        const id = ms.reduce((m, a) => (a.asset_id < m ? a.asset_id : m), ms[0].asset_id);
        return <KindsCluster key={`k:${id}`} members={ms} selectedAssetId={selectedAssetId} onSelect={onSelect} />;
      })}
    </>
  );
}

/** Draws its children where their launcher's symbol is drawn (a flight leaves the symbol, not the true spot). */
function TrackAtLauncher({ launcherId, children }: { launcherId: string | null; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const o = launcherId ? offsets.get(launcherId) : undefined;
    if (!g.current) return;
    if (o) g.current.position.copy(o);
    else g.current.position.set(0, 0, 0);
  });
  return <group ref={g}>{children}</group>;
}

// -----------------------------------------------------------------------------
// Per-asset callouts
// -----------------------------------------------------------------------------
// A small text label above each unclustered asset showing:
//   * short name (the declared callsign, else the asset_id)
//   * platform family
//   * for LAUNCHER-class: current/initial ammo summed across stores
// It is a screen-space Html overlay at the asset's ground position, lifted a
// fixed number of pixels with a 1 px CSS leader, so it keeps its size at any
// zoom. Clustered assets get no callout (the cluster draws kinds and counts).
//
// GATED on camera-zoom: labels only render when the camera is inside
// LABEL_VISIBLE_DISTANCE from the OrbitControls target.

const LABEL_VISIBLE_DISTANCE = 130;   // ~40% into the maxDistance=300 range
const LEADER_PX = 28;

/** Return the callout's "short name" for an asset: the declared callsign
 *  (ADR-0047: asset_id is opaque and is never split/sliced to derive a
 *  label) when one is set and distinct from asset_id, else the full
 *  asset_id. The boundary mapper is responsible for setting callsign to
 *  the short native-id segment this used to derive by splitting
 *  asset_id (see dynamic-mappings/proprietary-mapping.yaml in the
 *  customer bundle). */
function assetShortName(assetId: string, callsign: string | null): string {
  const cs = assetCallsign({ asset_id: assetId, callsign });
  return cs ?? assetId;
}

/** Family label derived from a platform_variant: strip the trailing
 *  role-suffix ("_Sensor" / "_Interceptor" / "_LAUNCHER") so the
 *  callout shows just the family (MRAD / SHORAD / CUAS / VSHORAD /
 *  MRAD_ADVANCED). The visible schematic already tells the operator
 *  whether it's a sensor or launcher; the callout only needs to say
 *  WHICH family they're looking at. */
function familyLabel(variant: string | null): string {
  if (!variant) return '';
  return variant.replace(/_(Sensor|Interceptor|LAUNCHER)$/, '');
}

const ZoomContext = createContext(false);

/** Track whether the camera is inside LABEL_VISIBLE_DISTANCE of the
 *  OrbitControls target. Runs a throttled check (~5 Hz) in useFrame
 *  so we don't set state 60 times a second; state changes only when
 *  the boolean flips. Provides the answer to every ZoomGate below it. */
function ZoomTracker({ children }: { children: React.ReactNode }) {
  const { camera, controls } = useThree() as unknown as {
    camera: THREE.Camera;
    controls: { target: THREE.Vector3 } | null;
  };
  const [zoomedIn, setZoomedIn] = useState(false);
  const lastCheck = useRef(0);
  useFrame(({ clock }) => {
    // 5 Hz check is enough -- zoom transitions are user-driven and
    // gradual. 60 Hz would just churn React state without visible
    // benefit.
    const now = clock.getElapsedTime();
    if (now - lastCheck.current < 0.2) return;
    lastCheck.current = now;
    const target = controls?.target ?? new THREE.Vector3(0, 0, 0);
    const d = camera.position.distanceTo(target);
    const next = d < LABEL_VISIBLE_DISTANCE;
    if (next !== zoomedIn) setZoomedIn(next);
  });
  return <ZoomContext.Provider value={zoomedIn}>{children}</ZoomContext.Provider>;
}

/** Renders its children only while the camera is zoomed in (see ZoomTracker). */
function ZoomGate({ children }: { children: React.ReactNode }) {
  return useContext(ZoomContext) ? <>{children}</> : null;
}

/** One callout: text with an underline, and a 1 px leader down to the asset.
 *  pointerEvents: none so 3D clicks pass through to the hit target beneath. */
function AssetCallout({ name, family, ammoText, launcherDepleted }: CalloutInfo) {
  const ammoClass = launcherDepleted
    ? 'text-rose-400 font-bold'
    : 'text-emerald-300';
  return (
    <Html
      position={[0, 0, 0]}
      style={{
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        // The label's bottom-left sits LEADER_PX above the asset's ground point.
        transform: `translate(0, calc(-100% - ${LEADER_PX}px))`,
      }}
    >
      <div
        data-testid="asset-callout"
        className="relative font-mono text-[10px] tracking-wider leading-tight rounded-t-sm bg-slate-950/75 border-b border-slate-300/80 pl-1 pr-2 py-0.5"
      >
        <span className="text-slate-100">{name}</span>
        {family && (
          <>
            <span className="text-slate-400 mx-1">·</span>
            <span className="text-slate-300">{family}</span>
          </>
        )}
        {ammoText && (
          <>
            <span className="text-slate-400 mx-1">·</span>
            <span className={ammoClass}>{ammoText}</span>
          </>
        )}
        <div className="absolute left-0 top-full w-px bg-slate-300/80 shadow-[0_0_2px_rgba(0,0,0,0.9)]" style={{ height: LEADER_PX }} />
      </div>
    </Html>
  );
}

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
// Severance state is the observed own-uplink state the rest of the view
// uses (edge_buffer_status.hq_link_severed). When
// severed, line styling + node coloring shift to red/dashed — matches the
// DdilNetworkLink convention.

/** Draws its children at a constant on-screen radius: they are authored at `radius` world units. */
function ScreenSized({ radius, px, children }: { radius: number; px: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const wp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g) return;
    g.getWorldPosition(wp);
    const fov = (camera as THREE.PerspectiveCamera).fov;
    g.scale.setScalar(markerScale(radius, px, camera.position.distanceTo(wp), size.height, fov));
  });
  return <group ref={ref}>{children}</group>;
}

function RegionalAggregatorNode({ position, label, kicker = 'REGIONAL AGGREGATOR', severed, grounded, stack }: {
  position: [number, number, number];
  label: string;
  /** The small line above the label; "REGIONAL · HQ" when HQ shares the regional node's site. */
  kicker?: string;
  severed: boolean;
  /** Lift the meshes so their base sits on the group origin (a node standing on the ground). */
  grounded?: boolean;
  /** With `grounded`: stand on top of a FOB hub at the same site instead of inside it. */
  stack?: boolean;
}) {
  const color = severed ? 0xf43f5e : 0x22d3ee;
  return (
    <group position={position} userData={{ insetHidden: true }}>
      {/* Solid octahedron core — logical node visual. Octahedron is
          deliberately not a shape any FOB or platform schematic uses, so
          it reads as "different category of thing." */}
      <ScreenSized radius={4.5} px={AGG_PX}>
       <group position={[0, grounded ? 4.5 + (stack ? stackLift(4.5, AGG_PX) : 0) : 0, 0]}>
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
            <div className="text-[9px] text-slate-400">{kicker}</div>
            <div className="text-slate-200 font-bold">{label}</div>
          </div>
        </Html>
       </group>
      </ScreenSized>
    </group>
  );
}

function HqMarker({ position, severed, grounded, stack, label = 'HQ THEATER' }: {
  position: [number, number, number];
  severed: boolean;
  /** Lift the meshes so their base sits on the group origin. */
  grounded?: boolean;
  /** With `grounded`: stand on top of a FOB hub at the same site instead of inside it. */
  stack?: boolean;
  label?: string;
}) {
  const color = severed ? 0xf43f5e : 0x10b981;
  return (
    <group position={position} userData={{ insetHidden: true }}>
      {/* Pyramid form — distinct from FOB hubs and regional octahedron.
          Cone with 4 radial segments approximates a pyramid. */}
      <ScreenSized radius={5.5} px={HQ_PX}>
       <group position={[0, grounded ? 5.25 + (stack ? stackLift(5.5, HQ_PX) : 0) : 0, 0]}>
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
            <div className="text-slate-200 font-bold">{label}</div>
          </div>
        </Html>
       </group>
      </ScreenSized>
    </group>
  );
}

/** A camera move to make once: bumping `n` starts a new one. */
interface CameraGoal { target: Vec3; pos: Vec3; n: number }
const EASE_S = 0.8;

/** Reports the pane's width / height (to 0.05) so the overview can fit a narrow pane. */
function AspectReporter({ onAspect }: { onAspect: (a: number) => void }) {
  const size = useThree((s) => s.size);
  useEffect(() => {
    if (size.height > 0) onAspect(Math.round((size.width / size.height) * 20) / 20);
  }, [size.width, size.height, onAspect]);
  return null;
}

function CameraRig({ goal }: { goal: CameraGoal | null }) {
  const { camera, controls } = useThree() as unknown as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update: () => void } | null;
  };
  const move = useRef<{ t: number; p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3 } | null>(null);
  const seen = useRef<number | null>(null);
  // eslint-disable-next-line react-hooks/immutability -- the R3F camera and controls are imperative three.js state, driven per frame
  useFrame((_, delta) => {
    if (!controls) return;
    // A new goal eases the camera there over EASE_S, once; after that
    // OrbitControls owns the camera again and the user can pan/orbit/zoom
    // freely. Initial camera position comes from <Canvas camera={{ position }}>.
    if (goal && goal.n !== seen.current) {
      seen.current = goal.n;
      move.current = {
        t: 0,
        p0: camera.position.clone(),
        t0: controls.target.clone(),
        p1: new THREE.Vector3(...goal.pos),
        t1: new THREE.Vector3(...goal.target),
      };
    }
    const m = move.current;
    if (m) {
      m.t = Math.min(1, m.t + delta / EASE_S);
      const k = m.t * m.t * (3 - 2 * m.t);
      camera.position.lerpVectors(m.p0, m.p1, k);
      controls.target.lerpVectors(m.t0, m.t1, k);
      if (m.t >= 1) move.current = null;
    }
    // Clip planes follow the zoom, so a 12 m vehicle and a 100 km map both hold depth.
    const d = camera.position.distanceTo(controls.target);
    // eslint-disable-next-line react-hooks/immutability -- the camera clip planes are three.js state set imperatively (R3F)
    camera.near = Math.max(1e-4, d / 300);
    camera.far = Math.max(1000, d * 50);
    camera.updateProjectionMatrix();
    if (m) controls.update();
  });
  return null;
}

function FogController({ isZoomed }: { isZoomed: boolean }) {
  // The scene comes from useFrame's own state: three.js objects are mutated
  // per frame by design, and the hook-value immutability rule does not apply.
  useFrame(({ scene, camera, controls }) => {
    if (scene.fog instanceof THREE.FogExp2) {
      // Fade distant context, don't erase it. The density scales with the distance to the orbit target
      // (fogDensity), so the overview (~200 units) is as clear as a close-up and only the horizon fades; a fixed
      // 0.005 hid most of the map at overview distance. Selecting an asset makes it a little denser; focus on the
      // asset itself comes from the brighter base ring on the AssetVisual `selected` path.
      const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
      const dist = target ? camera.position.distanceTo(target) : camera.position.length();
      scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, fogDensity(dist, isZoomed), 0.1);
    }
  });
  return null;
}

/** An on-map HQ farther than this from the regional site is left out of the terrain area. */
const HQ_FRAME_MAX_KM = 150;
/**
 * How far a ground-following link rides above the terrain, in scene units. HQ's 3 units is ~0.8 km at 400
 * units/deg; the same 3 here (80 units/deg, 0.72 units/km) would be ~4 km, so the regional map uses ~0.2 km.
 */
const REGIONAL_LINK_CLEAR = 0.15;
const SNAP_DEG = 0.1;          // terrain box grid: a moving asset does not reload the DEM
const quantise = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(6));

export default function RegionalSustainmentPosture({
  regionId,
  linkControl,
  aorAssetCount,
  selectedAssetId,
  onAssetSelect,
  onOpenHq,
}: {
  /** Opens the HQ view (the shell only); the off-map HQ chip is a button when set. */
  onOpenHq?: () => void;
  /** Active region pulldown selection; assets and projection are scoped to
   *  this region. Null = no region picked yet (cold start). */
  regionId: string | null;
  /** This hub's link control (one hook instance per page): the child ids
   *  whose links the status card counts. */
  linkControl: UseLinkControlResult;
  /** Row count of the AOR asset list, so the title and the list agree. */
  aorAssetCount: number;
  selectedAssetId: string | null;
  onAssetSelect: (id: string | null, type: string | null) => void;
}) {
  const fleet = useFleetAssetsForRegion(regionId);
  const logistics = useAllLogisticsStatus();
  const dep = deployment();
  const { fobs } = dep;
  // Stockpile feed for the 3D asset callouts (launcher rows only).
  // Fleet-wide is fine even though this view is region-scoped -- the
  // launcher's own asset_id already filters us to just this region's
  // launchers via calloutAmmo(id, ...).
  const stockpile = useMunitionsStockpile();
  // Callout ammo reads the effector ledger first (same as the loadout and
  // inventory cards); the feed above is the fallback (lib/calloutAmmo.ts).
  const effLaunches = useAllEffectorLaunches();
  const effResupplies = useAllEffectorResupply();
  const inFlightTracks = useInFlightMunitionTracks();
  const declaredLoad = moveInputs()?.declaredLoad;
  const ledgerClock = usePostureClock(5000);
  const ledger = useMemo(
    () => buildMunitionsLedger({
      fleet: fleet.data.map((a) => ({
        assetId: a.asset_id,
        variant: a.platform_variant,
        regionId: a.region_id,
      })),
      launches: effLaunches.data,
      resupplies: effResupplies.data,
      tracks: inFlightTracks.data,
      declaredLoad,
      regionId: undefined,
      asOfMs: ledgerClock,
    }),
    [fleet.data, effLaunches.data, effResupplies.data, inFlightTracks.data, declaredLoad, ledgerClock],
  );

  // 2026-07-13 Phase 5: split fleet into hardware vs. in-flight
  // munitions. Hardware renders as 3D assets on the map; in-flight
  // munitions surface only as a header ticker and as track dots (below),
  // both from munition_track (ADR-0049), never from these fleet rows.
  //
  // Rationale: MUNITION-class rows (fired interceptors + their seeker
  // payloads) share a platform_variant with launcher hardware
  // (*_Interceptor / MISSILE_LAUNCHER), so SCHEMATIC_REGISTRY would
  // route both to ArtillerySchematic. Left unfiltered, the map showed
  // a swarm of launcher silhouettes at the FOB during a scenario,
  // ~2 per firing, mixed with the real launcher hardware and
  // impossible to tell apart. The taxonomy fix is to render only
  // real hardware here and keep the effector activity on a separate
  // ticker.
  //
  // Capability set is fleet-wide (not region-scoped); LAUNCHER
  // membership is O(1) via a Set. Fine because the customer's
  // asset_capability_state is small (one row per real launcher --
  // in-flight munitions never land in that table by design).
  const allCapability = useAllCapabilityState();
  const munitionLaunches = useMunitionLaunches();
  const hardwareFleet = useMemo(() => {
    const classify = makeAssetClassifier(allCapability.data, munitionLaunches.data);
    return fleet.data.filter((a) => classify(a) !== 'MUNITION');
  }, [fleet.data, allCapability.data, munitionLaunches.data]);

  // In flight is the in-flight munition_track rows (ADR-0049), the same rows the
  // map draws as dots -- not MUNITION-class fleet rows. Region-scoped on the
  // row's own region_id when it has one.
  const regionTracks = useMemo(
    () => inFlightTracks.data.filter((t) => !regionId || !t.regionId || t.regionId === regionId),
    [inFlightTracks.data, regionId],
  );
  const inflightCount = regionTracks.length;
  // Trails read the feed, which also carries recently ended rows; the count above stays on in-flight.
  const trackFeed = useMunitionTrackFeed();
  const trailTracks = useMemo(
    () => trackFeed.data.filter((t) => !regionId || !t.regionId || t.regionId === regionId),
    [trackFeed.data, regionId],
  );

  // 5-tier liveness map. This is a REMOTE view of the edge, so
  // COMM_LOST (stale AND severed) is a legitimate reading here -- but
  // only from the OBSERVED edge_buffer_status row, never from the
  // commanded toggle state (which is what this used to read:
  // the regional view would show COMM_LOST the instant
  // someone flipped the toggle, before anything was actually observed
  // to be severed). In production this becomes a per-edge map from
  // edge_buffer_status; today it's a single global boolean. Uses
  // the hardware-only fleet so in-flight munitions don't distort
  // the STALE/LOST tiering.
  const { status: edgeBufferStatus, isError: isEdgeBufferError } = useEdgeBuffer();
  // Observed own-uplink reachability, shared by the topology visuals below.
  const uplinkUp = edgeBufferStatus?.hq_link_severed !== true;
  const uplinkIndicator = useLinkIndicator(edgeBufferStatus, isEdgeBufferError);
  const linkRows = useLinkStatus();
  const [linkNowMs, setLinkNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setLinkNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  // Every link this region monitors: the uplink plus each child's. Child ids
  // follow the control listing, or the link_status keys with control off. The
  // uplink counts as up only when observed up; anything unrecognised is the
  // unknown bucket.
  const linkReadings = useMemo<LinkReading[]>(() => {
    const childIds = linkControl.status === 'off'
      ? Array.from(linkRows.links.keys())
      : linkControl.children.map((c) => c.id);
    const uplink: LinkReading = {
      state: uplinkIndicator === 'up' ? 'up' : uplinkIndicator === 'severed' ? 'down' : 'unknown',
      declaredIdle: false,
    };
    return [uplink, ...childIds.map((id) => classifyLink(linkRows.links.get(id), linkNowMs))];
  }, [linkControl.status, linkControl.children, linkRows.links, uplinkIndicator, linkNowMs]);
  const linkCounts = summarizeLinks(linkReadings);
  const tiers = useFleetTiers(hardwareFleet, edgeBufferStatus?.hq_link_severed === true);

  // Project around the active region's FOBs so the camera bbox is the
  // region's geographic extent, not the whole theater.
  const regionFobs = useMemo(
    () => (regionId ? fobs.filter((f) => f.region_id === regionId) : fobs),
    [fobs, regionId],
  );
  // With no FOBs, centre on the fleet itself so live assets stay on screen. The
  // centre is rounded to 0.01 deg: terrain and the scene are registered to the
  // projection, so a creeping centre would reload them on every position update.
  const fleetPositions = useMemo(
    () => hardwareFleet.flatMap((a) => (a.position ? [a.position] : [])),
    [hardwareFleet],
  );
  const fallbackLat = fleetPositions.length
    ? quantise(fleetPositions.reduce((s, p) => s + p.lat, 0) / fleetPositions.length, 0.01) : null;
  const fallbackLon = fleetPositions.length
    ? quantise(fleetPositions.reduce((s, p) => s + p.lon, 0) / fleetPositions.length, 0.01) : null;
  const proj = useMemo(
    () =>
      makeProjection(
        regionFobs,
        SCENE_SCALE_UNITS_PER_DEG,
        fallbackLat === null || fallbackLon === null ? [] : [{ lat: fallbackLat, lon: fallbackLon }],
      ),
    [regionFobs, fallbackLat, fallbackLon],
  );

  // Terrain: the controls' state, the tile source, and the box around the FOBs
  // and every positioned asset.
  const [prefs, setPrefs] = useState<TerrainPrefs>(loadTerrainPrefs);
  const [holoOpen, setHoloOpen] = useState(false);
  const updatePrefs = useCallback((patch: Partial<TerrainPrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch };
      saveTerrainPrefs(next);
      return next;
    });
  }, []);
  const terrainSource = useMemo(() => resolveTerrainSource(dep.terrain), [dep.terrain]);
  // Where the regional node and HQ sit: the sites plan, or the abstract fallback.
  const sites = useMemo(() => resolveSites(dep, regionId), [dep, regionId]);
  // The regional site always counts; HQ only when it is near (an off-map HQ must not blow the area up).
  const siteBounds: { lat: number; lon: number }[] = [];
  if (sites.regional) siteBounds.push(sites.regional);
  if (sites.hq && (!sites.regional || distanceKm(sites.regional, sites.hq) <= HQ_FRAME_MAX_KM)) siteBounds.push(sites.hq);
  const rawBounds = terrainBounds([...regionFobs, ...fleetPositions, ...siteBounds]);
  const bounds = rawBounds ? snapBounds(rawBounds, SNAP_DEG) : null;
  // The slate relief is dark: lift it to read under the scene.
  const reliefGain = terrainSource.reliefPalette === 'slate' ? 1.6 : 1;
  const { data: terrainData, failed: terrainFailed } = useTerrain(prefs.on ? bounds : null, terrainSource, proj, reliefGain);
  const terrain = prefs.on ? terrainData : null;
  const exag = prefs.exag;
  // The muted surround around the terrain: same loader as the HQ map, centred on the terrain's bounds.
  const surroundLat = bounds ? (bounds.north + bounds.south) / 2 : null;
  const surroundLon = bounds ? (bounds.east + bounds.west) / 2 : null;
  const sBounds = useMemo(
    () => (prefs.on && surroundLat !== null && surroundLon !== null ? surroundBounds({ lat: surroundLat, lon: surroundLon }) : null),
    [prefs.on, surroundLat, surroundLon],
  );
  const surround = useSurround(sBounds, proj, terrainSource);
  const surroundMask = useMask(sBounds, terrainSource);
  const terrainRect = useMemo<Rect | null>(() => {
    if (!terrain) return null;
    const b = terrain.bounds;
    const [x0, z0] = proj.project(b.north, b.west);
    const [x1, z1] = proj.project(b.south, b.east);
    return [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];
  }, [terrain, proj]);
  // The terrain mutes towards its edge like the surround, but only while the surround is drawn.
  const edge = useMemo(
    () => (surround && terrainRect ? edgeRamp(terrainRect, 1 / HQ_SCALE) : undefined),
    [surround, terrainRect],
  );
  /** Ground height at a scene point: the terrain's, or 0 on the flat ground. */
  const groundAt = useCallback<GroundFn>(
    (x, z) => (terrain ? terrain.heightM(x, z) * M * exag : 0),
    [terrain, exag],
  );

  const { renderables, clusters } = useMemo(
    () => buildRenderables(hardwareFleet, logistics.data, fobs, proj, tiers, groundAt),
    [hardwareFleet, logistics.data, fobs, proj, tiers, groundAt],
  );

  // Track dots go through the same projection a fleet asset takes. The line
  // runs to the launcher only when it is rendered on this map.
  // Height is above the launcher's own altitude: the site elevation is not
  // flight. The track's base is the launcher's ground, so on terrain a
  // flight rises from the hillside it was fired from.
  const altById = useMemo(
    () => new Map(hardwareFleet.flatMap((a) => (a.position?.alt != null ? [[a.asset_id, a.position.alt] as const] : []))),
    [hardwareFleet],
  );
  const groundById = useMemo(
    () => new Map(renderables.map((a) => [a.asset_id, a.position[1]] as const)),
    [renderables],
  );
  const projectTrack = useCallback((t: (typeof trailTracks)[number]): Vec3 | null => {
    const ll = trackLatLon(t);
    if (!ll) return null;
    const [x, z] = proj.project(ll.lat, ll.lon);
    const launchAlt = t.launcherAssetId ? altById.get(t.launcherAssetId) : undefined;
    const base = t.launcherAssetId ? (groundById.get(t.launcherAssetId) ?? 0) : 0;
    return [x, clearOfGround(base + heightAboveLaunch(ll.h, launchAlt, UNITS_PER_KM), groundAt(x, z), UNITS_PER_KM), z];
  }, [proj, altById, groundById, groundAt]);
  const launcherOf = useCallback((t: (typeof trailTracks)[number]): Vec3 | undefined => {
    const p = t.launcherAssetId ? renderables.find((a) => a.asset_id === t.launcherAssetId)?.position : undefined;
    return p ? [p[0], p[1], p[2]] : undefined;
  }, [renderables]);
  const trails = useMunitionTrails(trailTracks, projectTrack, launcherOf);
  const trackById = useMemo(() => new Map(trailTracks.map((t) => [t.munitionAssetId, t])), [trailTracks]);
  // Target: the Fire PDU's target (effector_launch, by event_urn), at that asset's drawn position.
  const targetOf = useMemo(() => {
    const targetByUrn = new Map<string, string>();
    for (const l of effLaunches.data) if (l.eventUrn && l.targetAssetId) targetByUrn.set(l.eventUrn, l.targetAssetId);
    const posById = new Map(renderables.map((a) => [a.asset_id, a.position]));
    return (t: (typeof trailTracks)[number] | undefined): Vec3 | undefined => {
      const id = t?.eventUrn ? targetByUrn.get(t.eventUrn) : undefined;
      const p = id ? posById.get(id) : undefined;
      return p ? [p[0], p[1], p[2]] : undefined;
    };
  }, [effLaunches.data, renderables]);

  // Engagement inset: the same scene framed on what is in flight, assets as dots.
  // It draws no terrain (the terrain meshes are hidden from it); its ground
  // plane sits at the first launcher's ground, with markers at their own.
  const insetGround = trails.find((m) => m.launcher)?.launcher?.[1] ?? 0;
  const insetFocus = useMemo(
    () => engagementFocus(trails.map((m) => ({ trail: m.trail, launcher: m.launcher, target: targetOf(trackById.get(m.id)) }))),
    [trails, targetOf, trackById],
  );
  const insetMarkers = useMemo<InsetMarker[]>(() => [
    ...regionFobs.map((fob) => {
      const [x, z] = proj.project(fob.lat, fob.lon);
      return { at: [x, groundAt(x, z), z] as Vec3, color: '#94a3b8' };
    }),
    ...renderables.map((a) => ({
      at: [a.position[0], a.position[1], a.position[2]] as Vec3,
      color: a.force_id === 'FORCE_OPPOSING' ? '#fb7185' : a.force_id === 'FORCE_NEUTRAL' ? '#94a3b8' : '#22d3ee',
    })),
  ], [regionFobs, proj, renderables, groundAt]);
  const insetFrame = frameOf(insetFocus, insetGround);
  const insetLabel = `ENGAGEMENT · ${trails.filter((m) => !m.ending).length} IN FLIGHT${
    insetFrame ? ` · GRID ${gridStepKm(insetFrame.r, UNITS_PER_KM)} KM` : ''}`;

  // Callout text per asset (same name / family / ammo logic as before).
  const calloutOf = useCallback((a: RenderableAsset): CalloutInfo => {
    // Launcher ammo: ledger remaining/loaded, else the feed's current/max
    // (lib/calloutAmmo.ts). Non-launchers get null, so the ammo tail just
    // doesn't render.
    const ammo = calloutAmmo(a.asset_id, ledger, stockpile.entries);
    return {
      name: assetShortName(a.asset_id, a.callsign),
      family: familyLabel(a.platform_variant),
      ammoText: ammo ? ammo.text : null,
      launcherDepleted: ammo ? ammo.depleted : false,
    };
  }, [ledger, stockpile.entries]);
  const handleSelect = useCallback(
    (id: string, severity: string) => onAssetSelect(id, severity),
    [onAssetSelect],
  );

  // The plan below: the sites plan, or the abstract fallback.
  const plan = useMemo(() => {
    const regionalXZ = sites.regional ? proj.project(sites.regional.lat, sites.regional.lon) as [number, number] : null;
    const rect = framedRect([
      ...regionFobs.map((f) => proj.project(f.lat, f.lon) as [number, number]),
      ...(regionalXZ ? [regionalXZ] : []),
      ...renderables.map((a) => [a.position[0], a.position[2]] as [number, number]),
    ]);
    return planTopology({
      regionId: regionId ?? '',
      regional: sites.regional,
      hq: sites.hq,
      project: (lat, lon) => proj.project(lat, lon) as [number, number],
      rect,
    });
  }, [sites, proj, regionFobs, renderables, regionId]);
  // The FOB hubs and the regional node frame the overview, not just the assets.
  const framePoints = useMemo<Vec3[]>(() => {
    const pts: Vec3[] = regionFobs.map((f) => {
      const [x, z] = proj.project(f.lat, f.lon);
      return [x, groundAt(x, z), z];
    });
    if (plan.kind === 'sites') {
      pts.push([plan.regional.x, groundAt(plan.regional.x, plan.regional.z), plan.regional.z]);
      // The HQ chip sits on the padded rect's border; keep it inside the overview.
      const h = plan.hq;
      if (h.mode === 'offmap') pts.push([h.exit[0], groundAt(h.exit[0], h.exit[1]), h.exit[1]]);
      else if (h.mode === 'onmap') pts.push([h.x, groundAt(h.x, h.z), h.z]);
    }
    return pts;
  }, [regionFobs, proj, plan, groundAt]);
  const [aspect, setAspect] = useState(1.6);
  // The FOB whose edge preset was last chosen: its hub is emphasised, the other FOB links dim.
  const [focusEdge, setFocusEdge] = useState<string | null>(null);

  // Camera presets: OVERVIEW, each FOB / group, each launch in flight.
  const presets = useMemo<CameraPreset[]>(() => {
    const launches = trails.flatMap((m) => {
      if (m.ending || !m.launcher || m.trail.length === 0) return [];
      const lid = trackById.get(m.id)?.launcherAssetId;
      const la = lid ? renderables.find((a) => a.asset_id === lid) : undefined;
      if (!la) return [];
      const head = m.trail[m.trail.length - 1];
      return [{
        key: m.id,
        callsign: assetShortName(la.asset_id, la.callsign),
        launcher: m.launcher,
        dir: [head[0] - m.launcher[0], head[2] - m.launcher[2]] as [number, number],
      }];
    });
    return buildPresets({
      points: renderables.map((a) => a.position),
      framePoints,
      aspect,
      // A FOB is always a preset; a geometric group only when it has company.
      clusters: clusters
        .filter((c) => c.key.startsWith('edge:') || c.members.length > 1)
        .map((c) => ({ key: c.key, label: c.label, points: c.members.map((m) => m.position) })),
      launches,
    });
  }, [renderables, clusters, trails, trackById, framePoints, aspect]);
  const overview = presets.find((p) => p.key === 'overview');
  const sweepCenter: [number, number] = overview ? [overview.target[0], overview.target[2]] : [0, 0];

  // Camera goals: a preset button, or selecting an asset, flies there once.
  const [goal, setGoal] = useState<CameraGoal | null>(null);
  const goalCount = useRef(0);
  const fly = useCallback((v: { target: Vec3; pos: Vec3 }) => {
    goalCount.current += 1;
    setGoal({ target: v.target, pos: v.pos, n: goalCount.current });
  }, []);
  // The first time there is anything to frame, ease out to the overview.
  const framedOnce = useRef(false);
  useEffect(() => {
    if (framedOnce.current || !overview) return;
    framedOnce.current = true;
    if (goalCount.current === 0) fly(overview);
  }, [overview, fly]);
  const renderablesRef = useRef(renderables);
  useEffect(() => { renderablesRef.current = renderables; });
  useEffect(() => {
    if (!selectedAssetId) return;
    const a = renderablesRef.current.find((r) => r.asset_id === selectedAssetId);
    if (a) fly(assetFocus(a.position));
  }, [selectedAssetId, fly]);

  // Sharp imagery (satellite style only): tile rings around where the camera looks,
  // finer as it closes in (see ViewTiles).
  const [viewBoxes, setViewBoxes] = useState<TileBox[]>([]);
  const patchSpecs = useMemo<PatchSpec[]>(() => {
    if (!terrain || prefs.style !== 'sat' || terrainSource.patchImageryUrl === '') return [];
    return viewBoxes.map((b) => ({ bounds: tileBoxBounds(b), maxZoom: b.z, zoom: b.z }));
  }, [terrain, prefs.style, terrainSource.patchImageryUrl, viewBoxes]);
  const patches = usePatches(patchSpecs, terrainSource);

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

  // Stack heights follow the region's ground extent, over the ground under the centroid.
  const topo = useMemo(() => {
    if (!regionalCentroid) return null;
    const { x: cx, z: cz } = regionalCentroid;
    const pts: [number, number][] = [
      ...regionFobs.map((f) => proj.project(f.lat, f.lon) as [number, number]),
      ...renderables.map((a) => [a.position[0], a.position[2]] as [number, number]),
    ];
    const h = topologyHeights(regionExtent([cx, cz], pts));
    const g = groundAt(cx, cz);
    return { aggY: g + h.aggregator, hqY: g + h.hq };
  }, [regionalCentroid, regionFobs, proj, renderables, groundAt]);

  const usesMask = !!terrain?.mask && (prefs.style === 'holo' || terrainSource.basemap === 'relief');
  const credits = terrainFailed ? ['Terrain data unavailable'] : creditLines(terrainSource, {
    style: prefs.style,
    // The surround draws the land/sea mask (and the water file) too, so its sources are credited.
    landMask: usesMask || (!!surround && !!surroundMask.texture),
    water: (usesMask && !!terrain?.water) || (!!surround && (surround.water || surroundMask.water)),
  });

  return (
    <div className="col-span-2 panel flex flex-col relative overflow-hidden">
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start gap-4">
        <PostureHeader
          eyebrow={`REGION · ${(regionId ?? '—').toUpperCase()}`}
          title="REGIONAL SUSTAINMENT POSTURE"
          severed={!uplinkUp}
          meta={<>
            {aorAssetCount} ASSET{aorAssetCount === 1 ? '' : 'S'}
            <span className="ml-3 opacity-60">{renderables.length} ON MAP</span>
            {inflightCount > 0 && (
              <span className="ml-3 text-amber-400">
                · {inflightCount} IN FLIGHT
              </span>
            )}
          </>}
        >
          {presets.length > 0 && (
            <div data-testid="camera-presets" className="mt-2 flex max-w-xl flex-wrap gap-1 pointer-events-auto">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { fly(p); setFocusEdge(p.key.startsWith('edge:') ? p.key.slice('edge:'.length) : null); }}
                  className="border border-slate-700 bg-slate-900/80 px-2 py-0.5 font-mono text-[10px] tracking-widest text-slate-300 hover:border-emerald-500/60 hover:text-emerald-300"
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </PostureHeader>
        {/* Same card and chips as the HQ posture HUD (TheaterReadinessPosture), same opaque
            .panel-over-page fill so it matches the right column. */}
        <div
          data-testid="regional-link-hud"
          className="w-72 rounded-xl border border-zinc-800 bg-slate-950 bg-[linear-gradient(rgb(24_24_27/0.4),rgb(24_24_27/0.4))] shadow-lg px-4 py-3 text-left"
        >
          <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">THEATER LINK STATUS</h2>
          {/* Counts the uplink and every child link this region monitors,
              with the same helpers and colour rule as TheaterReadinessPosture's
              GLOBAL LINK STATUS. */}
          <LinkChips counts={linkCounts} />
        </div>
      </div>

      {/* The link legend rises above the terrain attribution when that is showing. */}
      <div className={`absolute ${prefs.on ? 'bottom-10' : 'bottom-4'} right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono`}>
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
        {/* isolation: drei <Html> labels carry z-indexes up to ~16.7M, which beat the z-10
            HUD overlays. A stacking context on the Canvas keeps them all beneath. */}
        <Canvas style={{ isolation: 'isolate' }} camera={{ position: [0, 150, 180], fov: 40 }} onPointerMissed={() => onAssetSelect(null, null)}>
          <color attach="background" args={[0x020617]} />
          <fogExp2 attach="fog" args={[0x020617, 0.005]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[50, 100, 50]} intensity={1.5} />
          <hemisphereLight groundColor={0x020617} intensity={0.5} />

          <OrbitControls makeDefault enableDamping dampingFactor={0.05} maxDistance={controlsMaxDistance(presets)} minDistance={0.01} maxPolarAngle={Math.PI / 2 - 0.1} zoomToCursor />

          <AspectReporter onAspect={setAspect} />
          <CameraRig goal={goal} />
          <FogController isZoomed={!!selectedAssetId} />

          {/* Ground: the real terrain when it is on and loaded, else the dark
              plane and grid. Geography matters MORE at AOR scope than at HQ
              (sensor coverage, terrain, towns), per ADR-0017's
              context-honesty discipline. */}
          {!terrain && <Terrain />}
          {surround && terrainRect && (
            <RegionalSurround data={surround} style={prefs.style} exag={exag} rect={terrainRect} mask={surroundMask.texture} cut={!!terrain}
              brightness={prefs.satBrightness} holo={prefs.holo} />
          )}
          {terrain && prefs.style === 'sat' && (
            <>
              <TerrainMesh data={terrain} exag={exag} brightness={prefs.satBrightness} edge={edge} />
              {patches.map((p) => <PatchMesh key={p.key} data={terrain} patch={p} exag={exag} brightness={prefs.satBrightness} edge={edge} />)}
              {terrainSource.patchImageryUrl !== '' && (
                <ViewTiles proj={terrain.proj} minZ={terrain.baseZoom + 1} maxZ={terrainSource.patchMaxZoom} onChange={setViewBoxes} />
              )}
            </>
          )}
          {terrain && prefs.style === 'holo' && (
            <HoloTerrain data={terrain} exag={exag} opts={prefs.holo} center={sweepCenter} edge={edge} />
          )}

          {/* Everything standing on the ground remounts when the terrain
              toggles, so nothing keeps a stale height. */}
          <ZoomTracker key={terrain ? 'terrain' : 'flat'}>
            {/* FOB hub markers — endpoints for the topology lines below.
                Without these, the per-FOB-to-aggregator lines would
                terminate "in midair" at FOB lat/lons (where assets
                cluster) with no visible node. */}
            {regionFobs.map((fob) => {
              const [x, z] = proj.project(fob.lat, fob.lon);
              return (
                <group key={`hub-${fob.edge_id}`} position={[x, groundAt(x, z), z]} userData={{ insetHidden: true }}>
                  <ScreenSized radius={4.7} px={focusEdge === fob.edge_id ? FOB_PX * 1.25 : FOB_PX}>
                    <LogisticsHubNode position={[0, 0, 0]} />
                    {focusEdge === fob.edge_id && (
                      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
                        <ringGeometry args={[5.4, 6.2, 40]} />
                        <meshBasicMaterial color="#10b981" transparent opacity={0.9} side={THREE.DoubleSide} />
                      </mesh>
                    )}
                  </ScreenSized>
                </group>
              );
            })}

            {/* Per-asset callouts live in each unclustered AssetMarker, behind
                the ZoomGate: none at the fleet-wide zoom, tight labels once the
                operator zooms in on a cluster. Each shows: <short name> ·
                <variant> (· <ammo> for launchers). */}
            {clusters.map((c) => (
              <ClusterGroup
                key={c.key}
                members={c.members}
                selectedAssetId={selectedAssetId}
                onSelect={handleSelect}
                calloutOf={calloutOf}
              />
            ))}

            {/* In-flight tracks: not assets, so no click, callout or list entry. */}
            {trails.map((m) => (
              <TrackAtLauncher key={`track-${m.id}`} launcherId={trackById.get(m.id)?.launcherAssetId ?? null}>
                <MunitionTrackHolo
                  track={trackById.get(m.id) ?? { munitionAssetId: m.id, launcherAssetId: null }}
                  trail={m.trail}
                  groundY={m.launcher?.[1] ?? insetGround}
                  launcher={m.launcher}
                  target={targetOf(trackById.get(m.id))}
                  ending={m.ending}
                  curtain={trails.length <= CURTAIN_MAX_TRACKS}
                />
              </TrackAtLauncher>
            ))}
          </ZoomTracker>

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
          {plan.kind === 'fallback' && regionalCentroid && topo && (
            <>
              {regionFobs.map((fob) => {
                const [fx, fz] = proj.project(fob.lat, fob.lon);
                return (
                  <DdilNetworkLink
                    key={`fob-link-${fob.edge_id}`}
                    start={new THREE.Vector3(fx, groundAt(fx, fz), fz)}
                    end={new THREE.Vector3(regionalCentroid.x, topo.aggY, regionalCentroid.z)}
                    status={uplinkUp ? 'NOMINAL' : 'SEVERED'}
                    dim={focusEdge !== null && focusEdge !== fob.edge_id}
                  />
                );
              })}
              <DdilNetworkLink
                start={new THREE.Vector3(regionalCentroid.x, topo.aggY, regionalCentroid.z)}
                end={new THREE.Vector3(regionalCentroid.x, topo.hqY, regionalCentroid.z)}
                status={uplinkUp ? 'NOMINAL' : 'SEVERED'}
              />
              <RegionalAggregatorNode
                position={[regionalCentroid.x, topo.aggY, regionalCentroid.z]}
                label={(regionId ?? '').toUpperCase()}
                severed={!uplinkUp}
              />
              <HqMarker
                position={[regionalCentroid.x, topo.hqY, regionalCentroid.z]}
                severed={!uplinkUp}
              />
            </>
          )}
          {plan.kind === 'sites' && (() => {
            const status = uplinkUp ? 'NOMINAL' : 'SEVERED';
            const node = plan.regional;
            const nodeG = groundAt(node.x, node.z);
            const nodeV = new THREE.Vector3(node.x, nodeG, node.z);
            const hq = plan.hq;
            const kicker = hq.mode === 'colocated' ? 'REGIONAL · HQ' : undefined;
            // A region FOB at the regional site (or at the on-map HQ) shares its spot: the marker
            // stands on that FOB's hub and the zero-length link to it is skipped.
            const regFob = sites.regional ? regionFobs.find((f) => sameSite(f, sites.regional!)) : undefined;
            const hqFob = hq.mode === 'onmap' && sites.hq ? regionFobs.find((f) => sameSite(f, sites.hq!)) : undefined;
            return (
              <>
                {regionFobs.filter((fob) => fob !== regFob).map((fob) => {
                  const [fx, fz] = proj.project(fob.lat, fob.lon);
                  return (
                    <DdilNetworkLink
                      key={`fob-link-${fob.edge_id}`}
                      start={new THREE.Vector3(fx, groundAt(fx, fz), fz)}
                      end={nodeV}
                      groundY={groundAt}
                      clearance={REGIONAL_LINK_CLEAR}
                      status={status}
                      dim={focusEdge !== null && focusEdge !== fob.edge_id}
                    />
                  );
                })}
                <RegionalAggregatorNode position={[node.x, nodeG, node.z]} label={node.label} kicker={kicker} severed={!uplinkUp} grounded stack={!!regFob} />
                {hq.mode === 'abstract' && topo && (
                  <>
                    <DdilNetworkLink
                      start={nodeV}
                      end={new THREE.Vector3(node.x, nodeG + (topo.hqY - topo.aggY), node.z)}
                      status={status}
                    />
                    <HqMarker position={[node.x, nodeG + (topo.hqY - topo.aggY), node.z]} severed={!uplinkUp} />
                  </>
                )}
                {hq.mode === 'onmap' && (
                  <>
                    <DdilNetworkLink
                      start={nodeV}
                      end={new THREE.Vector3(hq.x, groundAt(hq.x, hq.z), hq.z)}
                      groundY={groundAt}
                      clearance={REGIONAL_LINK_CLEAR}
                      status={status}
                    />
                    <HqMarker
                      position={[hq.x, groundAt(hq.x, hq.z), hq.z]}
                      severed={!uplinkUp}
                      grounded
                      stack={!!hqFob}
                      label={sites.hq?.label ?? 'HQ'}
                    />
                  </>
                )}
                {hq.mode === 'offmap' && (
                  <>
                    <DdilNetworkLink
                      start={nodeV}
                      end={new THREE.Vector3(hq.exit[0], groundAt(hq.exit[0], hq.exit[1]), hq.exit[1])}
                      groundY={groundAt}
                      clearance={REGIONAL_LINK_CLEAR}
                      status={status}
                    />
                    <group position={[hq.exit[0], groundAt(hq.exit[0], hq.exit[1]), hq.exit[1]]}>
                      <HqChip km={hq.km} bearing={hq.bearing} from={nodeV} at={new THREE.Vector3(hq.exit[0], groundAt(hq.exit[0], hq.exit[1]), hq.exit[1])} onOpen={onOpenHq} />
                    </group>
                  </>
                )}
              </>
            );
          })()}
          <EngagementInset focus={insetFocus} markers={insetMarkers} groundY={insetGround} unitsPerKm={UNITS_PER_KM} rect={REGIONAL_INSET_RECT} renderMain />
        </Canvas>
        <EngagementInsetFrame visible={insetFocus.length > 0} label={insetLabel} rect={REGIONAL_INSET_RECT} />
      </div>

      {/* Terrain controls, above the mouse hint. */}
      <div
        data-testid="terrain-controls"
        className="absolute bottom-10 left-4 z-10 pointer-events-auto font-mono text-[10px] uppercase tracking-wider"
      >
        {prefs.on && prefs.style === 'holo' && holoOpen && (
          <div data-testid="holo-panel" className="mb-1">
            <HoloPanel opts={prefs.holo} set={(holo: HoloOpts) => updatePrefs({ holo })} masked={!!terrain?.mask} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border border-slate-700 bg-slate-900/80 px-2 py-1">
          <button
            type="button"
            data-testid="terrain-toggle"
            aria-pressed={prefs.on}
            onClick={() => updatePrefs({ on: !prefs.on })}
            className={segBtn(prefs.on)}
          >
            TERRAIN {prefs.on ? 'ON' : 'OFF'}
          </button>
          {prefs.on && (
            <>
              <div role="group" aria-label="Terrain style" className="flex">
                <button
                  type="button"
                  data-testid="terrain-style-holo"
                  aria-pressed={prefs.style === 'holo'}
                  onClick={() => updatePrefs({ style: 'holo' as TerrainStyle })}
                  className={segBtn(prefs.style === 'holo')}
                >
                  HOLO
                </button>
                {prefs.style === 'holo' && (
                  <button
                    type="button"
                    data-testid="terrain-holo-gear"
                    aria-label="Holo settings"
                    aria-expanded={holoOpen}
                    onClick={() => setHoloOpen((o) => !o)}
                    className={segBtn(holoOpen)}
                  >
                    ⚙
                  </button>
                )}
                <button
                  type="button"
                  data-testid="terrain-style-sat"
                  aria-pressed={prefs.style === 'sat'}
                  onClick={() => updatePrefs({ style: 'sat' as TerrainStyle })}
                  className={segBtn(prefs.style === 'sat')}
                >
                  {styleLabel(terrainSource.basemap)}
                </button>
              </div>
              <div role="group" aria-label="Relief exaggeration" className="flex items-center gap-1">
                <span className="text-slate-500">RELIEF</span>
                {EXAGGERATIONS.map((x: Exaggeration) => (
                  <button
                    key={x}
                    type="button"
                    data-testid={`terrain-relief-${x}`}
                    aria-pressed={prefs.exag === x}
                    onClick={() => updatePrefs({ exag: x })}
                    className={segBtn(prefs.exag === x)}
                  >
                    ×{x}
                  </button>
                ))}
              </div>
              {prefs.style === 'sat' && (
                <label className="flex items-center gap-1">
                  <span className="text-slate-500">BRIGHTNESS</span>
                  <input
                    type="range"
                    data-testid="terrain-sat-brightness"
                    aria-label="Satellite brightness"
                    min={SAT_BRIGHTNESS_MIN}
                    max={SAT_BRIGHTNESS_MAX}
                    step={0.05}
                    value={prefs.satBrightness}
                    onChange={(e) => updatePrefs({ satBrightness: Number(e.target.value) })}
                    className="w-20 accent-cyan-400"
                  />
                </label>
              )}
            </>
          )}
        </div>
      </div>

      {prefs.on && (
        <div
          data-testid="terrain-attribution"
          className="absolute bottom-1 right-4 z-10 max-w-[60%] text-right text-[9px] font-mono text-slate-500 pointer-events-none"
        >
          {credits.map((l) => <div key={l}>{l}</div>)}
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN REGION • [RMB] ROTATE VIEW • [SCROLL] MAGNIFY
      </div>
    </div>
  );
}
