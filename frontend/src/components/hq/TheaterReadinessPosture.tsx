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
import { useFleetAssets, useAllLogisticsStatus } from '../../hooks';
import { makeProjection } from '../../lib/geoProjection';

// Scene scale: HQ canvas spans ~2000 units; ~400 units per deg of lat
// puts a regional-sized bbox (~3°) at ~1200 units across — comfortably
// within view at the default (0, 150, 600) camera.
const HQ_SCENE_SCALE_UNITS_PER_DEG = 400;

// Per-FOB composition breakdown, derived from each asset's platform_variant.
// Categories match the customer ORBAT enum buckets:
//   * sensors        — *_Sensor (4 tiers)
//   * interceptors   — *_Interceptor (4 tiers) + MISSILE_LAUNCHER
//   * facilities     — AIR_DEFENSE_SITE / HEADQUARTER_COMPLEX /
//                      INSTALLATION_FACILITY_CIVILIAN
//   * other          — everything else (legacy DIS fleet: M1A2-SEPv3,
//                      AH-64E; plus any unrecognized platform_variant)
//
// Reading the COP: a healthy posture has a balanced sensors:interceptors
// ratio per FOB. Composition pills on the FOB labels make this instantly
// visible at HQ scale without a per-asset zoom.
function categoryOf(variant: string | null | undefined): 'sensors' | 'interceptors' | 'facilities' | 'other' {
  if (!variant) return 'other';
  if (variant.endsWith('_Sensor')) return 'sensors';
  if (variant.endsWith('_Interceptor') || variant === 'MISSILE_LAUNCHER') return 'interceptors';
  if (variant === 'AIR_DEFENSE_SITE' ||
      variant === 'HEADQUARTER_COMPLEX' ||
      variant === 'INSTALLATION_FACILITY_CIVILIAN') return 'facilities';
  return 'other';
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
    interceptors: number;
    facilities: number;
    other: number;
  };
}

function buildFobMetrics(
  fobs: Fob[],
  fleet: ReturnType<typeof useFleetAssets>['data'],
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'],
  scale: number,
): FobMetrics[] {
  const proj = makeProjection(fobs, scale);
  const sevByAsset = new Map(logistics.map((l) => [l.asset_id, l.overall_severity]));

  return fobs.map((fob) => {
    const [x, z] = proj.project(fob.lat, fob.lon);
    const assets = fleet.filter((a) => a.edge_id === fob.edge_id);
    const bySev = new Map<string, number>();
    const composition = { sensors: 0, interceptors: 0, facilities: 0, other: 0 };
    for (const a of assets) {
      const sev = sevByAsset.get(a.asset_id) ?? 'LOGISTICS_SEVERITY_UNSPECIFIED';
      bySev.set(sev, (bySev.get(sev) ?? 0) + 1);
      composition[categoryOf(a.platform_variant)]++;
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
 * Posture rollup across the whole theater. Buckets every logistics status
 * row by severity tier and surfaces it as a single header banner: how many
 * READY vs OFFLINE vs UNKNOWN. Pairs with the per-FOB composition pill to
 * give the HQ commander an at-a-glance "is the posture green or not?"
 * answer without zooming into any FOB.
 */
interface PostureRollup {
  ready: number;
  degraded: number;
  offline: number;
  unknown: number;
}
function buildPostureRollup(
  logistics: ReturnType<typeof useAllLogisticsStatus>['data'],
  totalAssets: number,
): PostureRollup {
  const rollup: PostureRollup = { ready: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const l of logistics) {
    switch (l.overall_severity) {
      case 'LOGISTICS_SEVERITY_OK': rollup.ready++; break;
      case 'LOGISTICS_SEVERITY_DEGRADED': rollup.degraded++; break;
      case 'LOGISTICS_SEVERITY_CRITICAL':
      case 'LOGISTICS_SEVERITY_NON_OPERATIONAL': rollup.offline++; break;
      default: rollup.unknown++;
    }
  }
  // Any asset in fleet but missing from logistics_status (typical for
  // assets that haven't yet been evaluated by the fusion service) is
  // counted as unknown. Keeps the totals consistent with the FOB labels.
  const accountedFor = rollup.ready + rollup.degraded + rollup.offline + rollup.unknown;
  if (totalAssets > accountedFor) rollup.unknown += totalAssets - accountedFor;
  return rollup;
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
  composition: { sensors: number; interceptors: number; facilities: number; other: number };
}) {
  // Composition pill — show categories that have at least one asset. A
  // FOB with only "other"-class assets (legacy DIS) gets the plain total;
  // a FOB with a mix of sensors+interceptors+facilities gets the categorized
  // breakdown that tells the air-defense-posture story at a glance.
  const hasOrbatComposition =
      composition.sensors > 0 || composition.interceptors > 0 || composition.facilities > 0;
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
            {composition.interceptors > 0 && (
              <span className="text-amber-300">{composition.interceptors} INTC</span>
            )}
            {composition.facilities > 0 && (
              <span className="text-slate-400">{composition.facilities} FAC</span>
            )}
            {composition.other > 0 && (
              <span className="text-slate-500">{composition.other} OTHER</span>
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
  const fleet = useFleetAssets();
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

  // Force-posture rollup — same fleet, bucketed by overall_severity from
  // the fusion service. Shows next to GLOBAL LINK STATUS in the header so
  // the commander gets two-axis read at a glance: "are the links up?" AND
  // "are the assets ready?"
  const posture = useMemo(
    () => buildPostureRollup(logistics.data, fleet.data.length),
    [logistics.data, fleet.data.length],
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
          {/* FORCE POSTURE — fleet-level (fusion-computed logistics severity).
              Only the non-zero buckets render so a fully-ready posture
              reads as a clean "N READY" rather than a noisy "N/0/0/0". */}
          <div className="bg-slate-900/80 p-2 border border-slate-700">
            <div className="text-[10px] text-slate-500 mb-1">FORCE POSTURE</div>
            <div className="text-xl font-bold flex items-center justify-end font-rajdhani">
              <span className="text-emerald-400">{posture.ready} READY</span>
              {posture.degraded > 0 && (
                <span className="text-amber-400 ml-4">{posture.degraded} DEGRADED</span>
              )}
              {posture.offline > 0 && (
                <span className="text-rose-400 ml-4">{posture.offline} OFFLINE</span>
              )}
              {posture.unknown > 0 && (
                <span className="text-slate-400 ml-4">{posture.unknown} UNKNOWN</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2"><div className="w-3 h-3 bg-emerald-500"></div><span className="text-slate-300">NOMINAL LINK</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-rose-500"></div><span className="text-slate-300">SEVERED LINK</span></div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 150, 600], fov: 45 }}>
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
            fadeDistance={1500}
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
