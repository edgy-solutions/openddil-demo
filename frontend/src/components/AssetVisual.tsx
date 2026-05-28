// =============================================================================
// AssetVisual — three-tier render cascade for one asset on a 3D map
// =============================================================================
// Replaces the previous bubble-only AssetMarker. Used by:
//   * RegionalSustainmentPosture (scene scale ~0.3-0.4 per asset)
//   * TheaterReadinessPosture (HQ — currently shows FOBs only; assets may
//     be added in a future enrichment)
//   * AssetDeepDive zoom-in (scale ~1.0, future Phase 5 follow-up)
//
// Cascade order, per platform_variant:
//   Tier 1 — GLB model from GLB_REGISTRY (currently empty; per-platform
//            glTF binaries land here as they're sourced; e.g.
//            HEADQUARTER_COMPLEX -> '/models/hq.glb' once we have one)
//   Tier 2 — schematic from SCHEMATIC_REGISTRY in platform-schematics/
//            (the 12-entry ORBAT registry + legacy DIS variants)
//   Tier 3 — UnknownPlatformBadge (labeled wireframe octahedron)
//
// Why no auto-fallback through other schematics: the maintainer
// VehicleClassSchematic is tank-class specific, the sensor schematic is
// radar-class specific. Falling through "any unrecognized platform" to
// a tank silhouette would render an LTAMDS as a tank — actively
// misleading. UnknownPlatformBadge is honest about uncertainty.
//
// Base ring (severity color):
//   * Always rendered beneath the schematic/GLB so severity is visible
//     even if the upper layer fails to load
//   * Color priority: force_id (FOE/NEUTRAL) > severity (CRITICAL/DEGRADED)
//     > severity OK (green) > severity UNSPECIFIED (slate)
//   * Force_id override matters for non-mobile entities (sensors,
//     facilities) where logistics severity may be UNSPECIFIED today but
//     friend/foe affiliation is the load-bearing visual signal

import { Suspense, Component, useMemo } from 'react';
import type { ReactNode, ComponentType } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
    SCHEMATIC_REGISTRY,
    UnknownPlatformBadge,
    type SchematicProps,
} from './platform-schematics';

// ---------------------------------------------------------------------------
// GLB_REGISTRY — empty placeholder. Per-platform GLBs land here as they're
// sourced. New entries do not require AssetVisual changes; the cascade
// dispatches by registry presence.
//
// Stryker.glb is intentionally NOT mapped to any current platform_variant
// because the live fleet has tracked M1A2 tanks (different silhouette).
// himars.glb and ugv.glb are unmapped for similar fit reasons. Park them
// for now; the cascade falls cleanly to SCHEMATIC_REGISTRY.
// ---------------------------------------------------------------------------
const GLB_REGISTRY: Record<string, string> = {
    // 'HEADQUARTER_COMPLEX': '/models/hq-complex.glb',   // when sourced
    // 'SHORAD_Sensor':       '/models/radar-shorad.glb', // when sourced
};

// ---------------------------------------------------------------------------
// Severity / force-affiliation type contracts
// ---------------------------------------------------------------------------
// LogisticsSeverity values mirror the proto enum strings (the SPA's
// useAllLogisticsStatus hook surfaces them as strings).
export type LogisticsSeverityName =
    | 'LOGISTICS_SEVERITY_UNSPECIFIED'
    | 'LOGISTICS_SEVERITY_OK'
    | 'LOGISTICS_SEVERITY_DEGRADED'
    | 'LOGISTICS_SEVERITY_CRITICAL'
    | 'LOGISTICS_SEVERITY_NON_OPERATIONAL';

// ForceAffiliation values mirror the proto enum strings.
export type ForceAffiliationName =
    | 'FORCE_UNSPECIFIED'
    | 'FORCE_FRIENDLY'
    | 'FORCE_OPPOSING'
    | 'FORCE_NEUTRAL'
    | 'FORCE_UNKNOWN'
    // Backward-compat for any consumer that uses the older naming.
    | string;

export interface AssetVisualProps {
    /** Canonical platform_variant from telemetry_latest_state. Drives the
     *  cascade key lookup. Null/missing -> UnknownPlatformBadge. */
    platformVariant: string | null | undefined;

    /** Per-asset logistics severity from useAllLogisticsStatus. Drives the
     *  base ring color when force_id doesn't override (FRIENDLY or unspecified
     *  affiliation). */
    severity?: LogisticsSeverityName | string | null;

    /** Force affiliation from telemetry_latest_state.force_id. Overrides
     *  severity for the base ring when set to FORCE_OPPOSING or
     *  FORCE_NEUTRAL — the load-bearing visual for non-mobile entities. */
    forceId?: ForceAffiliationName | null;

    /** Wrapping group scale. Regional view passes ~0.3-0.4; HQ ~0.5-0.6;
     *  deep-dive ~1.0. */
    scale?: number;

    /** When true, the base ring renders a brighter highlight indicating
     *  the asset is currently selected in the picker. */
    selected?: boolean;
}

// ---------------------------------------------------------------------------
// Internal: ring + GLB renderer
// ---------------------------------------------------------------------------

const COLOR_FRIENDLY  = '#22d3ee'; // cyan — distinct from severity green
const COLOR_OPPOSING  = '#f43f5e'; // rose
const COLOR_NEUTRAL   = '#94a3b8'; // slate

const COLOR_OK        = '#10b981'; // emerald — matches schematic indicator-OK
const COLOR_DEGRADED  = '#f59e0b'; // amber — matches schematic indicator-DEGRADED
const COLOR_CRITICAL  = '#ef4444'; // red — matches schematic indicator-CRITICAL
const COLOR_UNKNOWN   = '#64748b'; // slate-500 — no claim

// =============================================================================
// Per-platform ground-baseline offset
// =============================================================================
// The maintainer-view schematics were authored at "single-asset close-up"
// scale with the asset centered around the origin (some geometry above
// Y=0, some below). At maintainer scale that's fine — the camera looks at
// origin and the framing centers vertically.
//
// On regional/HQ maps, every asset sits ON the ground plane (Y=0). If a
// schematic has geometry extending below Y=0 (e.g. Artillery's hinge at
// Y=-2, M1A2's hull bottom at Y=-0.8), that geometry passes through the
// terrain and the asset reads as "half buried."
//
// Fix: per-schematic ground-baseline offset. Each value is the schematic's
// native lowest-point Y (negative), so we wrap the schematic in a
// `<group position={[0, -lowestY, 0]}>` to lift it. Scale is applied AFTER
// the offset so it stays in sync at any zoom level.
//
// Static-bounds offset is enough for non-animated schematics. ArtillerySchematic
// (interceptors + MISSILE_LAUNCHER) animates its pod on X-axis ±0.2 rad
// around a 0.5 rad bias — the pod's front edge sweeps ~3 units BELOW the
// schematic's static lower bound during the tilt cycle. Static offset
// alone leaves the front of the pod dipping into the terrain on every
// scan. Fix has two parts: (1) raise their GROUND_OFFSET to clear the
// animated dip, (2) render a visible launching pad beneath them so the
// dip lands ON a platform surface (see LAUNCH_PADS below).
//
// Native Y bounds (eyeballed from each schematic's geometry):
//   LaserShorad   cylinder [-4, +4]              ground_offset = 4
//   Artillery     hinge -2.5, animated dip ~-4.5 ground_offset = 4.5 (+pad)
//   M1A2          hull -0.8, turret +2           ground_offset = 0.8
//   SensorRadar   base -1.1, dish ~+2.5          ground_offset = 1.1
//   Quadruped     legs reach Y≈-0.5 below origin ground_offset = 0.5
//   Facilities    pad at -0.85, building above   ground_offset = 1.0
//   UnknownBadge  octahedron centered at origin  ground_offset = 1.6
const GROUND_OFFSET: Record<string, number> = {
    // ORBAT sensors — all use SensorRadarSchematic; base at Y=-1.1
    'CUAS_Sensor':    1.1,
    'VSHORAD_Sensor': 1.1,
    'SHORAD_Sensor':  1.1,
    'MRAD_Sensor':    1.1,
    // ORBAT interceptors + launcher — Artillery schematic; clears animated
    // pod tilt dip when combined with the LAUNCH_PADS pad height
    'CUAS_Interceptor':    4.5,
    'VSHORAD_Interceptor': 4.5,
    'SHORAD_Interceptor':  4.5,
    'MRAD_Interceptor':    4.5,
    'MISSILE_LAUNCHER':    4.5,
    // ORBAT facilities — pad bottom around Y=-1.0
    'AIR_DEFENSE_SITE':              1.0,
    'HEADQUARTER_COMPLEX':           1.0,
    'INSTALLATION_FACILITY_CIVILIAN': 1.0,
    // Legacy DIS variants
    'M1A2-SEPv3': 0.8,
    'M1A2-SEPv2': 0.8,
    'AH-64E':     0.5,
};
// Default when no entry matches (UnknownPlatformBadge or any other
// rendered fallback). Picks the octahedron's radius so the wireframe
// doesn't punch through the ground plane.
const DEFAULT_GROUND_OFFSET = 1.6;

// =============================================================================
// Per-platform visible height
// =============================================================================
// Top-of-asset extent in the schematic's NATIVE (unscaled) frame, used to
// size the selected-asset spotlight cylinder so it just barely envelops
// the silhouette — slightly taller and slightly wider than the asset, so
// the operator sees a faint glow surrounding the selection rather than a
// disembodied prop next to it. Without this, the cylinder used a fixed
// `radius * 4` height that dwarfed sensors and looked detached from
// launchers.
//
// Values are top-of-visible-geometry in each schematic's native frame
// (the schematic's bottom is already at Y=0 in world space after the
// GROUND_OFFSET lift, so this is also the schematic's world-Y top
// before scale-multiplication).
const ASSET_HEIGHT: Record<string, number> = {
    // Sensors: base (-1.1) to dish/rim top (~+2.5). Slightly larger for
    // the bigger-dish tiers so the cylinder grows with the radar tier.
    'CUAS_Sensor':    3.4,
    'VSHORAD_Sensor': 3.6,
    'SHORAD_Sensor':  3.9,
    'MRAD_Sensor':    4.2,
    // Interceptors + launcher: ArtillerySchematic hinge (-2.5) to pod top
    // (~+3.75 with peak tilt). Picked to envelop the animated pod cycle.
    'CUAS_Interceptor':    6.5,
    'VSHORAD_Interceptor': 6.5,
    'SHORAD_Interceptor':  6.5,
    'MRAD_Interceptor':    6.5,
    'MISSILE_LAUNCHER':    6.5,
    // Facilities: pad/building stacked, conservative envelope
    'AIR_DEFENSE_SITE':              3.5,
    'HEADQUARTER_COMPLEX':           4.5,
    'INSTALLATION_FACILITY_CIVILIAN': 3.5,
    // Legacy DIS
    'M1A2-SEPv3': 3.0,
    'M1A2-SEPv2': 3.0,
    'AH-64E':     2.5,
};
const DEFAULT_ASSET_HEIGHT = 3.2;

// =============================================================================
// LAUNCH_PADS — visible platform pad rendered beneath animated launchers
// =============================================================================
// Real launcher batteries sit on a concrete pad — the schematic with no
// base reads as "floating equipment." More importantly, the Artillery pod
// animation sweeps below the schematic's static lower bound; the pad
// gives that motion something to dip TOWARD instead of dipping into the
// terrain. Visual + functional fix in one mesh.
//
// Pad height of 0.8 (unscaled) was tuned against ArtillerySchematic's
// peak tilt dip (~1.5 below hinge bottom). With GROUND_OFFSET=4.5 the
// schematic origin sits at Y=4.5 in asset frame; pod-front-bottom at peak
// tilt lands around Y=0.8 — exactly on the pad surface.
const LAUNCH_PADS: Record<string, number> = {
    'CUAS_Interceptor':    0.8,
    'VSHORAD_Interceptor': 0.8,
    'SHORAD_Interceptor':  0.8,
    'MRAD_Interceptor':    0.8,
    'MISSILE_LAUNCHER':    0.8,
};

function LaunchPad({ height, radius }: { height: number; radius: number }) {
    return (
        <group>
            {/* Slab body — dark slate, matches schematic palette so the pad
                reads as part of the same visual lineage rather than terrain */}
            <mesh position={[0, height / 2, 0]}>
                <cylinderGeometry args={[radius, radius * 1.05, height, 24]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.5} roughness={0.5} />
            </mesh>
            {/* Cyan accent ring at the pad's top edge — same family as
                SensorRadar's base-cyan accent so launchers and sensors share
                the visual grammar */}
            <mesh position={[0, height + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[radius * 0.82, radius * 0.95, 24]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.5} side={THREE.DoubleSide} />
            </mesh>
        </group>
    );
}

function ringColor(
    severity: AssetVisualProps['severity'],
    forceId: AssetVisualProps['forceId'],
): string {
    // Force affiliation overrides severity. An enemy SHORAD reads red even
    // if its logistics severity is OK; a neutral civilian facility reads
    // slate even if degraded.
    if (forceId === 'FORCE_OPPOSING') return COLOR_OPPOSING;
    if (forceId === 'FORCE_NEUTRAL')  return COLOR_NEUTRAL;
    // Otherwise severity drives color. FRIENDLY entities use severity tint;
    // unset force_id same.
    switch (severity) {
        case 'LOGISTICS_SEVERITY_OK':            return COLOR_OK;
        case 'LOGISTICS_SEVERITY_DEGRADED':      return COLOR_DEGRADED;
        case 'LOGISTICS_SEVERITY_CRITICAL':
        case 'LOGISTICS_SEVERITY_NON_OPERATIONAL': return COLOR_CRITICAL;
        default:                                 return forceId === 'FORCE_FRIENDLY' ? COLOR_FRIENDLY : COLOR_UNKNOWN;
    }
}

function SeverityBaseRing({ color, radius, selected, selectedHeight }: {
    color: string;
    radius: number;
    selected?: boolean;
    /** When selected, the spotlight cylinder is sized to envelop the
     *  schematic — slightly taller and slightly wider than the asset.
     *  Without this, the cylinder used a fixed radius * 4 height that
     *  dwarfed sensors and looked detached from launchers. */
    selectedHeight?: number;
}) {
    // Cylinder envelope: 15% taller and at the ring's outer radius. The
    // operator sees a faint cyan glow that just barely surrounds the
    // schematic instead of a disembodied prop next to it.
    const cylHeight = (selectedHeight ?? radius * 2) * 1.15;
    return (
        <>
            {/* Primary ring — flat on ground plane (Y up), thin annulus */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <ringGeometry args={[radius * 0.85, radius, 32]} />
                <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} />
            </mesh>
            {/* Selected — bright cyan halo ring + faint solid disc + vertical
                spotlight cylinder. The Regional view dims fog on click; this
                triple-stack makes the selected asset POP through the fog so
                "focus here" reads instantly. Without it, the asset blurred
                in with sibling assets and only the topology lines stayed
                bright. */}
            {selected && (
                <>
                    {/* Outer halo — wider + brighter than the severity ring */}
                    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
                        <ringGeometry args={[radius * 1.2, radius * 1.5, 32]} />
                        <meshBasicMaterial color="#22d3ee" transparent opacity={0.9} side={THREE.DoubleSide} />
                    </mesh>
                    {/* Faint disc inside the ring — makes the base glow */}
                    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
                        <circleGeometry args={[radius * 0.85, 32]} />
                        <meshBasicMaterial color="#22d3ee" transparent opacity={0.15} side={THREE.DoubleSide} />
                    </mesh>
                    {/* Vertical spotlight cylinder — envelope-sized so it
                        just surrounds the asset's silhouette. Radius matches
                        the severity ring's outer edge; height is the asset's
                        own height + 15%. Open-ended cylinder + low opacity
                        gives the glow effect without obscuring the schematic
                        inside. */}
                    <mesh position={[0, cylHeight / 2, 0]}>
                        <cylinderGeometry args={[radius, radius, cylHeight, 24, 1, true]} />
                        <meshBasicMaterial color="#22d3ee" transparent opacity={0.08} side={THREE.DoubleSide} depthWrite={false} />
                    </mesh>
                </>
            )}
        </>
    );
}

function GlbModel({ url, scale }: { url: string; scale: number }) {
    const { scene } = useGLTF(url);
    // Clone so multiple AssetVisuals using the same GLB don't share a scene
    // graph (and so r3f's reconciler treats them as distinct mounts).
    const cloned = useMemo(() => scene.clone(), [scene]);
    return <primitive object={cloned} scale={scale} />;
}

// Per ADR-0017 — pure-3D component, no DOM. ErrorBoundary fallback is
// itself a 3D primitive (UnknownPlatformBadge wrapped in a group).
class SchematicErrorBoundary extends Component<
    { fallback: ReactNode; children: ReactNode },
    { hasError: boolean }
> {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    render() {
        return this.state.hasError ? this.props.fallback : this.props.children;
    }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
export default function AssetVisual({
    platformVariant,
    severity,
    forceId,
    scale = 0.4,
    selected,
}: AssetVisualProps) {
    const glbUrl = platformVariant ? GLB_REGISTRY[platformVariant] : undefined;
    const SchematicComp: ComponentType<SchematicProps> | undefined =
        platformVariant ? SCHEMATIC_REGISTRY[platformVariant] : undefined;

    // Severity-equivalent "degraded" flag for the schematic's own indicator
    // strip animation. Friendly + severity > OK -> show degraded animation.
    // Non-friendly entities (foes / neutrals / unknowns) -> always nominal
    // schematic animation; the ring is doing the affiliation work.
    const schematicDegraded =
        forceId !== 'FORCE_OPPOSING' && forceId !== 'FORCE_NEUTRAL' &&
        (severity === 'LOGISTICS_SEVERITY_DEGRADED' ||
         severity === 'LOGISTICS_SEVERITY_CRITICAL' ||
         severity === 'LOGISTICS_SEVERITY_NON_OPERATIONAL');

    const ring = ringColor(severity, forceId);

    // Lift the schematic so its geometric bottom sits at Y=0 (ground
    // plane). Without this, schematics extending below Y=0 in their
    // native frame (Artillery hinge, M1A2 hull, etc.) render half-buried
    // in the terrain at regional/HQ scale. Multiply by `scale` since the
    // inner schematic group is scaled — the offset has to scale with it.
    const groundOffset = platformVariant
        ? (GROUND_OFFSET[platformVariant] ?? DEFAULT_GROUND_OFFSET)
        : DEFAULT_GROUND_OFFSET;
    const liftedY = groundOffset * scale;

    // Launcher platform pad — visible base under animated launchers. Renders
    // at Y=0..padHeight (scaled) so it sits ON the ground; the schematic's
    // larger GROUND_OFFSET lifts the pod above the pad surface.
    const padHeight = platformVariant ? LAUNCH_PADS[platformVariant] : undefined;

    // Selected-asset spotlight cylinder height — sized per asset so the
    // glow envelops the silhouette rather than dwarfing or undersizing it.
    const assetHeightNative = platformVariant
        ? (ASSET_HEIGHT[platformVariant] ?? DEFAULT_ASSET_HEIGHT)
        : DEFAULT_ASSET_HEIGHT;
    const selectedCylHeight = assetHeightNative * scale;

    // Fallback used by both Suspense (GLB load) and ErrorBoundary (render
    // crash). One source of truth so a GLB swap-out vs a buggy schematic
    // look identical to the operator.
    const fallback = (
        <group position={[0, DEFAULT_GROUND_OFFSET * scale, 0]} scale={scale}>
            <UnknownPlatformBadge degraded={false} variant={platformVariant ?? 'UNKNOWN'} />
        </group>
    );

    return (
        <group>
            <SeverityBaseRing
                color={ring}
                radius={Math.max(1, 3 * scale)}
                selected={selected}
                selectedHeight={selectedCylHeight}
            />
            {padHeight !== undefined && (
                <LaunchPad height={padHeight * scale} radius={Math.max(0.9, 2.5 * scale)} />
            )}
            <SchematicErrorBoundary fallback={fallback}>
                <Suspense fallback={fallback}>
                    {glbUrl ? (
                        <group position={[0, liftedY, 0]} scale={scale}>
                            <GlbModel url={glbUrl} scale={1} />
                        </group>
                    ) : SchematicComp ? (
                        <group position={[0, liftedY, 0]} scale={scale}>
                            <SchematicComp degraded={schematicDegraded} />
                        </group>
                    ) : (
                        fallback
                    )}
                </Suspense>
            </SchematicErrorBoundary>
        </group>
    );
}
