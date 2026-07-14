// =============================================================================
// TheaterReadinessPosture — theater-tier readiness 3D map
// =============================================================================
// Phase A backend wiring: was DEMO_MOCK with a hardcoded REGIONS array of 4
// fabricated regions and 17 Math.random()-scattered "radar" nodes, all
// DDIL link statuses driven by one global boolean. Now reads:
//
//   * deployment().fobs              — deployment-supplied FOB list. Each
//                                       FOB is rendered as a hub node at
//                                       its real geographic position.
//   * useFleetAssets()               — every asset in the pipeline; counted
//                                       per FOB by edge_id.
//   * useAllLogisticsStatus()        — overall_severity per asset, used to
//                                       break the count down per FOB.
//
// DDIL links: one per FOB, from theater origin (0, 0, 0) to the FOB's
// projected position. Status comes from `severed` (currently a single
// hq-link-severed bool wired in from HqApp). Per-FOB link health is a
// Phase B follow-up — needs a per-edge buffer status hook.
//
// Phase B owns: visual polish, label placement, clutter management at
// scale, per-edge link status, severity-breakdown styling.
// =============================================================================
import React, { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import DdilNetworkLink from '../DdilNetworkLink';
import LogisticsHubNode from '../LogisticsHubNode';
import TacticalMapUnderlay from '../TacticalMapUnderlay';
import { deployment, type Fob } from '../../deployment';
import {
  useClassifiedFleet,
  useAllLogisticsStatus,
  type ClassifiedFleetAsset,
} from '../../hooks';
import { type AssetClass } from '../../lib/assetClass';
import { makeProjection } from '../../lib/geoProjection';

// Scene scale: HQ canvas spans ~2000 units; ~400 units per deg of lat
// puts a regional-sized bbox (~3°) at ~1200 units across — comfortably
// within view at the default (0, 150, 600) camera.
const HQ_SCENE_SCALE_UNITS_PER_DEG = 400;

// Per-FOB composition breakdown, driven by the asset_class discriminator
// (src/lib/assetClass.ts) rather than by platform_variant pattern-matching.
// The class separates fired-and-in-flight MUNITIONs from LAUNCHERs even
// though both can carry the same platform_variant -- the discriminator
// is "does the asset emit a weapons-capability snapshot."
//
// Categories:
//   * sensors        — asset_class = SENSOR
//   * launchers      — asset_class = LAUNCHER  (real launcher hardware)
//   * facilities     — asset_class = FACILITY
//   * inflight       — asset_class = MUNITION  (fired, in flight, transient)
//   * other          — PLATFORM / UNKNOWN (legacy DIS, unresolved variants)
//
// Reading the COP: a healthy posture has a balanced sensors:launchers
// ratio per FOB. In-flight munitions are shown as a per-FOB ticker so
// the commander can see engagement activity at a glance without
// polluting the hardware counts.
function categoryOf(cls: AssetClass): 'sensors' | 'launchers' | 'facilities' | 'inflight' | 'other' {
  switch (cls) {
    case 'SENSOR':   return 'sensors';
    case 'LAUNCHER': return 'launchers';
    case 'FACILITY': return 'facilities';
    case 'MUNITION': return 'inflight';
    default:         return 'other';
  }
}

interface FobMetrics {
  fob: Fob;
  /** [x, z] in scene units. */
  scenePos: [number, number];
  total: number;
  byOverallSeverity: Map<string, number>;
  /** Per-category composition counts. Drives the FobLabel composition pill. */
  composition: {
    sensors: number;
    launchers: number;
    facilities: number;
    inflight: number;   // fired munitions currently in flight
    other: number;
  };
}

function buildFobMetrics(
  fobs: Fob[],
  fleet: ClassifiedFleetAsset[],
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'],
  scale: number,
): FobMetrics[] {
  const proj = makeProjection(fobs, scale);
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));

  return fobs.map((fob) => {
    const [x, z] = proj.project(fob.lat, fob.lon);
    const assets = fleet.filter((a) => a.edge_id === fob.edge_id);
    const bySev = new Map<string, number>();
    const composition = {
      sensors: 0, launchers: 0, facilities: 0, inflight: 0, other: 0,
    };
    for (const a of assets) {
      const sev = sevByAsset.get(a.asset_id) ?? 'LOGISTICS_SEVERITY_UNSPECIFIED';
      bySev.set(sev, (bySev.get(sev) ?? 0) + 1);
      composition[categoryOf(a.asset_class)]++;
    }
    return {
      fob,
      scenePos: [x, z],
      total: assets.length,
      byOverallSeverity: bySev,
      composition,
    };
  });
}

/**
 * Posture rollup PER asset_class. Instead of one merged bucket that
 * mixed hardware severity with in-flight munition noise (the 2026-07-08
 * "126 in FORCE POSTURE, 97 in Configuration Posture" divergence),
 * this separates the classes so:
 *   * Hardware readiness (SENSORS + LAUNCHERS + FACILITIES) is the
 *     primary commander question. Munitions in flight don't dilute it.
 *   * IN FLIGHT is a separate ticker showing engagement activity.
 *   * The invariant `ready+degraded+offline+unknown == class_total`
 *     holds within each rollup (symmetric correction, unlike the old
 *     one-way `if totalAssets > accountedFor` clamp).
 *
 * Iteration order: fleet-driven, not logistics-driven. Every asset in
 * `fleet` gets bucketed exactly once by severity via a lookup into
 * logistics; assets with no logistics row default to UNKNOWN. This
 * guarantees totals = fleet.length by construction; there's no way for
 * an orphan logistics row (a stale asset_logistics_status entry whose
 * telemetry_latest_state row has TTL'd out) to inflate the total.
 */
interface PostureRollup {
  ready: number;
  degraded: number;
  offline: number;
  unknown: number;
  total: number;
}

function emptyRollup(): PostureRollup {
  return { ready: 0, degraded: 0, offline: 0, unknown: 0, total: 0 };
}

function bucketSeverity(sev: string | undefined): keyof Omit<PostureRollup, 'total'> {
  switch (sev) {
    case 'LOGISTICS_SEVERITY_OK':
      return 'ready';
    case 'LOGISTICS_SEVERITY_DEGRADED':
      return 'degraded';
    case 'LOGISTICS_SEVERITY_CRITICAL':
    case 'LOGISTICS_SEVERITY_NON_OPERATIONAL':
      return 'offline';
    default:
      return 'unknown';
  }
}

interface ClassRollups {
  sensors:    PostureRollup;
  launchers:  PostureRollup;
  facilities: PostureRollup;
  inflight:   PostureRollup;
  other:      PostureRollup;
}

function buildPostureRollups(
  fleet: ClassifiedFleetAsset[],
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'],
): ClassRollups {
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));
  const rollups: ClassRollups = {
    sensors:    emptyRollup(),
    launchers:  emptyRollup(),
    facilities: emptyRollup(),
    inflight:   emptyRollup(),
    other:      emptyRollup(),
  };
  for (const a of fleet) {
    const cat = categoryOf(a.asset_class);
    const bucket = bucketSeverity(sevByAsset.get(a.asset_id));
    rollups[cat][bucket]++;
    rollups[cat].total++;
  }
  return rollups;
}

/** One row of the FORCE POSTURE panel: LABEL then ready/degraded/offline/
 *  unknown counts, then a "N total" summary. Only non-zero severity
 *  buckets render VISIBLE text, but each severity ALWAYS occupies its
 *  own table column so labels stay column-aligned across rows even when
 *  a row has fewer active severities than its siblings (e.g. a fully-
 *  ready SENSORS row alongside a partially-degraded LAUNCHERS row --
 *  before this the SENSORS label drifted right because there were
 *  fewer spans to justify against).
 *
 *  Rendered as <tr> to sit inside the ClassRollupTable's <table>;
 *  table-column semantics do the alignment work for free.
 */
function ClassRollupLine({
  label, rollup,
}: {
  label: string;
  rollup: PostureRollup;
}) {
  return (
    <tr className="font-mono text-[11px] tracking-wider">
      <td className="text-slate-500 pr-3 text-left tabular-nums">{label}</td>
      <td className="text-right tabular-nums px-1 text-emerald-400">
        {rollup.ready > 0 ? `${rollup.ready} READY` : ''}
      </td>
      <td className="text-right tabular-nums px-1 text-amber-400">
        {rollup.degraded > 0 ? `${rollup.degraded} DEG` : ''}
      </td>
      <td className="text-right tabular-nums px-1 text-rose-400">
        {rollup.offline > 0 ? `${rollup.offline} OFF` : ''}
      </td>
      <td className="text-right tabular-nums px-1 text-slate-400">
        {rollup.unknown > 0 ? `${rollup.unknown} UNK` : ''}
      </td>
      <td className="text-right tabular-nums pl-3 text-slate-600 whitespace-nowrap">
        {rollup.total} total
      </td>
    </tr>
  );
}

function AbstractContinents() {
  // Procedural decorative terrain — unchanged from the previous pass.
  const geoRef = useRef<THREE.PlaneGeometry>(null);
  useMemo(() => {
    if (geoRef.current) {
      const pos = geoRef.current.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vz = pos.getZ(i);
        let y = Math.sin(vx * 0.005) * Math.cos(vz * 0.005) * 40;
        y += Math.sin(vx * 0.02) * Math.cos(vz * 0.02) * 15;
        if (y < 5) y = -10;
        pos.setY(i, y - 5);
      }
      geoRef.current.computeVertexNormals();
    }
  }, []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -5, 0]}>
      <planeGeometry ref={geoRef} args={[2000, 2000, 60, 60]} />
      <meshStandardMaterial color={0x020617} metalness={0.6} roughness={0.4} flatShading={true} />
    </mesh>
  );
}

function FobLabel({
  position, label, total, composition,
}: {
  position: [number, number, number];
  label: string;
  total: number;
  composition: {
    sensors: number; launchers: number; facilities: number;
    inflight: number; other: number;
  };
}) {
  // Composition pill: sensors + LAUNCHER hardware + facilities. In-flight
  // munitions surface as a smaller separate ticker (IN FLIGHT: N) so
  // they don't distort the hardware picture -- a FOB with 4 launchers
  // that just fired 20 interceptors is still "4 launchers," not "24."
  // Legacy DIS / unresolved variants fall through to `other`.
  const hasOrbatComposition =
      composition.sensors > 0 || composition.launchers > 0 || composition.facilities > 0;
  return (
    <Html
      position={position}
      center
      style={{
        // Small floating badge above the FOB marker — pointerEvents none so
        // OrbitControls still receives drags through it.
        pointerEvents: 'none',
        transform: 'translateY(-32px)',
        whiteSpace: 'nowrap',
      }}
    >
      <div className="font-mono text-[10px] tracking-widest text-cyan-200 bg-slate-900/80 border border-slate-700 px-2 py-1 rounded-sm">
        <div className="text-slate-200 font-bold">{label}</div>
        {hasOrbatComposition ? (
          <div className="flex gap-2 text-[9px] mt-0.5">
            {composition.sensors > 0 && (
              <span className="text-cyan-300">{composition.sensors} SENS</span>
            )}
            {composition.launchers > 0 && (
              <span className="text-amber-300">{composition.launchers} LNCH</span>
            )}
            {composition.facilities > 0 && (
              <span className="text-slate-400">{composition.facilities} FAC</span>
            )}
            {composition.other > 0 && (
              <span className="text-slate-500">{composition.other} OTHER</span>
            )}
            {composition.inflight > 0 && (
              <span className="text-amber-500 border-l border-slate-700 pl-2">
                {composition.inflight} FLT
              </span>
            )}
          </div>
        ) : (
          <div className="text-[9px] text-slate-400">
            {total} ASSET{total === 1 ? '' : 'S'}
          </div>
        )}
      </div>
    </Html>
  );
}

export default function TheaterReadinessPosture({
  severed,
}: {
  /** True when the hq-link is severed — wired from HqApp's useEdgeBuffer.
   *  Drives the per-FOB DDIL link color and the GLOBAL LINK STATUS overlay. */
  severed: boolean;
}) {
  const { fobs } = deployment();
  const fleet = useClassifiedFleet();
  const logistics = useAllLogisticsStatus();

  // Projection is computed once here and shared with both the FOB metrics
  // (for marker positions) and the TacticalMapUnderlay (so a deployment-
  // configured map image lines up with the FOBs geographically).
  const proj = useMemo(
    () => makeProjection(fobs, HQ_SCENE_SCALE_UNITS_PER_DEG),
    [fobs],
  );

  const metrics = useMemo(
    () => buildFobMetrics(fobs, fleet.data, logistics.data, HQ_SCENE_SCALE_UNITS_PER_DEG),
    [fobs, fleet.data, logistics.data],
  );

  // Per-class posture rollups: hardware (SENSORS / LAUNCHERS / FACILITIES)
  // gets a severity breakdown; fired MUNITIONs (in flight) get a count.
  // The severity/class split solves two divergences we saw earlier:
  //   1. FORCE POSTURE (asset_logistics_status count) diverging from
  //      the GLOBAL FLEET header (telemetry_latest_state count). Fleet-
  //      driven iteration guarantees per-class total = per-class fleet.
  //   2. LAUNCHER hardware readiness being polluted by fired-and-in-flight
  //      munition rows using the same platform_variant.
  const rollups = useMemo(
    () => buildPostureRollups(fleet.data, logistics.data),
    [fleet.data, logistics.data],
  );

  // With one global hq_link_severed today, every FOB shares the same
  // link color. linksUp/linksDown count over the FOB list, not the
  // pre-§A invented "17 radars."
  const totalLinks = metrics.length;
  const linksUp = severed ? 0 : totalLinks;
  const linksDown = severed ? totalLinks : 0;

  return (
    <div className={`col-span-2 panel flex flex-col relative overflow-hidden transition-all duration-500 ${severed ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`} id="panel-theater-readiness">
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start">
        <div>
          <h1 className={`glitch-text text-3xl font-bold transition-colors ${!severed ? 'text-emerald-400 shadow-[0_0_10px_#10b981]' : 'text-rose-500 shadow-[0_0_10px_#f43f5e]'}`} style={{ textShadow: !severed ? '0 0 10px #10b981' : '0 0 10px #f43f5e' }}>
            THEATER READINESS POSTURE
          </h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400 mt-1">
            GLOBAL FLEET // {fobs.length} FOB{fobs.length === 1 ? '' : 'S'} // {fleet.data.length} ASSET{fleet.data.length === 1 ? '' : 'S'}
          </p>
        </div>
        <div className="text-right flex flex-col gap-2">
          {/* GLOBAL LINK STATUS — transport-level (the hq_link_severed signal) */}
          <div className="bg-slate-900/80 p-2 border border-slate-700">
            <div className="text-[10px] text-slate-500 mb-1">GLOBAL LINK STATUS</div>
            <div className="text-xl font-bold flex items-center justify-end font-rajdhani">
              <span className="text-emerald-400">{linksUp} UP</span>
              {linksDown > 0 && (
                <span className="text-rose-400 ml-4">{linksDown} DOWN</span>
              )}
            </div>
          </div>
          {/* FORCE POSTURE — split by asset_class so the commander sees
              hardware readiness cleanly instead of one merged bucket
              polluted by in-flight munition telemetry rows. Only the
              non-empty classes render, so a facility-less deployment
              reads as SENSORS+LAUNCHERS rather than SENSORS+LAUNCHERS+
              (0 FACILITIES). IN FLIGHT is a separate ticker -- it's
              an activity signal, not a readiness one.

              Full munitions inventory (per-type available/expended/
              failed rollup) lands in the sibling MUNITIONS panel in
              Phase 3, once we've confirmed the initial-ammo derivation
              rule against a fresh scenario. Until then, IN FLIGHT is
              the placeholder that at least tells the commander an
              engagement is under way. */}
          <div className="bg-slate-900/80 p-2 border border-slate-700">
            <div className="text-[10px] text-slate-500 mb-1">FORCE POSTURE</div>
            {/* Table so class labels + severity counts + totals stay
                column-aligned across rows. Individual severity cells
                render empty when zero (still occupy the column slot),
                which keeps the alignment invariant regardless of how
                many severities are active on each row -- the earlier
                flex-justify-end layout had SENSORS drift right when
                the row had fewer active severities than LAUNCHERS. */}
            <table className="w-full">
              <tbody>
                <ClassRollupLine label="SENSORS"    rollup={rollups.sensors} />
                <ClassRollupLine label="LAUNCHERS"  rollup={rollups.launchers} />
                {rollups.facilities.total > 0 && (
                  <ClassRollupLine label="FACILITIES" rollup={rollups.facilities} />
                )}
                {rollups.other.total > 0 && (
                  <ClassRollupLine label="OTHER" rollup={rollups.other} />
                )}
              </tbody>
            </table>
            {rollups.inflight.total > 0 && (
              <div className="flex items-center justify-end font-mono text-[11px] tracking-wider pt-1 mt-1 border-t border-slate-700">
                <span className="text-slate-500 mr-2">IN FLIGHT</span>
                <span className="text-amber-300 font-bold">{rollups.inflight.total}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2"><div className="w-3 h-3 bg-emerald-500"></div><span className="text-slate-300">NOMINAL LINK</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-rose-500"></div><span className="text-slate-300">SEVERED LINK</span></div>
      </div>

      <div className="absolute inset-0 cursor-move">
        {/* Camera far plane lifted from default 2000 → 8000. AbstractContinents
            is a 2000×2000 plane at Y=-5 with material color 0x020617 (same as
            background + fog far color). At max zoom (OrbitControls maxDistance
            1200) on a 45° angle, the far edge of AbstractContinents lands at
            ~2030 units from camera — past the default far plane. It gets
            clipped, blends into the background, and reads as "horizon dropping
            into solid color and blanking the screen" on zoom-out. 8000 leaves
            comfortable headroom for any camera position the OrbitControls
            permits + the full scene extent. */}
        <Canvas camera={{ position: [0, 150, 600], fov: 45, near: 0.1, far: 8000 }}>
          <color attach="background" args={[0x020617]} />
          {/* Linear fog: starts at 200 (close-range depth cue stays the
              same as before) and reaches full opacity at 4000. Earlier
              the far value was 1500, which is below the OrbitControls
              maxDistance of 1200 + the scene's lateral extent (~600
              units across) — so at max zoom-out, far points of the
              ground plane were at ~1400-1500 distance from camera and
              hit the fog wall, blanking the view as "horizon dropping
              into the haze." 4000 keeps depth cueing for the FOB region
              while leaving headroom for the user to zoom out and still
              see the scene. */}
          <fog attach="fog" args={[0x020617, 200, 4000]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[200, 500, 200]} intensity={1.5} color={0x22d3ee} />
          <hemisphereLight groundColor={0x020617} intensity={0.5} />

          <OrbitControls enableDamping dampingFactor={0.05} maxDistance={1200} minDistance={200} maxPolarAngle={Math.PI / 2 - 0.1} target={[0, 0, 0]} />

          <Grid
            position={[0, -2, 0]}
            args={[2000, 2000]}
            cellSize={20}
            cellThickness={0.5}
            sectionSize={100}
            sectionThickness={1.5}
            cellColor="#22d3ee"
            sectionColor="#10b981"
            /* drei's Grid fadeDistance is the camera-distance over which
             * the grid lines fade to transparent (default 100). Earlier
             * fadeDistance=1500 meant the grid was nearly invisible when
             * the user zoomed out to OrbitControls maxDistance=1200 — the
             * fade factor at that distance was (1500-1200)/1500 = 0.2,
             * leaving only 20% of the grid intensity. Combined with the
             * AbstractContinents clipping past the camera far plane,
             * this read as "scene blanks on zoom-out." 5000 keeps the
             * grid visible at any camera position the OrbitControls
             * permits. */
            fadeDistance={5000}
          />

          {/* Concentric rings — visual scale reference, unchanged. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[200, 202, 64]} />
            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[400, 404, 64]} />
            <meshBasicMaterial color={0x10b981} transparent opacity={0.1} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[600, 606, 64]} />
            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.05} side={THREE.DoubleSide} />
          </mesh>

          <AbstractContinents />

          {/* FOB hub nodes — one per deployment().fobs. */}
          {metrics.map((m) => (
            <LogisticsHubNode key={`hub-${m.fob.edge_id}`} position={[m.scenePos[0], 0, m.scenePos[1]]} />
          ))}

          {/* DDIL links from theater origin to each FOB. */}
          {metrics.map((m) => (
            <DdilNetworkLink
              key={`link-${m.fob.edge_id}`}
              start={new THREE.Vector3(0, 0, 0)}
              end={new THREE.Vector3(m.scenePos[0], 0, m.scenePos[1])}
              status={severed ? 'SEVERED' : 'NOMINAL'}
            />
          ))}

          {/* Per-FOB label + composition breakdown. */}
          {metrics.map((m) => (
            <FobLabel
              key={`label-${m.fob.edge_id}`}
              position={[m.scenePos[0], 0, m.scenePos[1]]}
              label={m.fob.label || m.fob.edge_id}
              total={m.total}
              composition={m.composition}
            />
          ))}

          <React.Suspense fallback={null}>
            <TacticalMapUnderlay projection={proj} />
          </React.Suspense>

          <EffectComposer>
            <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} luminanceSmoothing={0.9} />
          </EffectComposer>
        </Canvas>
      </div>

      {severed && <div className="absolute inset-0 bg-rose-950/30 z-20 pointer-events-none"></div>}

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN CONTINENT • [RMB] ROTATE • [SCROLL] ZOOM
      </div>
    </div>
  );
}
