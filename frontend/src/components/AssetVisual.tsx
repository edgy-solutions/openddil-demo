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

    /** Phase 5 (ADR-0026): per-axis operational posture passed through to
     *  the schematic. Allows schematics to react to specific values (e.g.
     *  POWER_STATE_OFF dims all indicators) beyond the rolled-up `degraded`
     *  boolean. Optional — schematics that don't read it stay
     *  nominal-vs-degraded only. */
    operationalState?: SchematicProps['operationalState'];

    /** 5-tier liveness classification (see lib/assetTier). When STALE or
     *  COMM_LOST, the base ring overrides to slate / amber and drops its
     *  opacity so the asset visibly recedes from the live fleet. When
     *  ACTIVE/DEGRADED the standard severity ring color is used; LOST
     *  isn't rendered (callers filter before constructing the marker).
     *  Optional -- when absent the component renders as if ACTIVE. */
    tier?: import('../lib/assetTier').AssetTier;
}

// ---------------------------------------------------------------------------
// Internal: ring + GLB renderer
// ---------------------------------------------------------------------------
// Color constants + the severity × force-affiliation policy live in
// lib/ringColor.ts so the contract is testable without three.js.
// Re-export them here for in-file readability; tests in
// __tests__/ringColor.test.ts pin every branch.
import { ringColor } from '../lib/ringColor';

// Per-platform geometry — GROUND_OFFSET, ASSET_HEIGHT,
// ASSET_FOOTPRINT_RADIUS, LAUNCH_PADS, PAD_RADIUS_NATIVE — live in
// lib/assetGeometry.ts so the tables + invariants are unit-testable.
// __tests__/assetGeometry.test.ts pins them: every variant in
// ASSET_HEIGHT has a GROUND_OFFSET entry; launcher pad height equals
// (groundOffset - hinge_native_bottom); launcher ASSET_HEIGHT covers
// peak-tilt pod corner; pad radius sized to hinge, ring sized to pod.
import {
    resolveGroundOffset,
    resolveAssetHeight,
    resolvePadHeight,
    resolvePadWorldRadius,
    resolveRingRadius,
    resolveVariantScale,
} from '../lib/assetGeometry';

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

function SeverityBaseRing({ color, radius, selected, selectedHeight, opacityScale = 1 }: {
    color: string;
    radius: number;
    selected?: boolean;
    /** When selected, the spotlight cylinder is sized to envelop the
     *  schematic — slightly taller and slightly wider than the asset.
     *  Without this, the cylinder used a fixed radius * 4 height that
     *  dwarfed sensors and looked detached from launchers. */
    selectedHeight?: number;
    /** Multiplier on the primary-ring opacity (0..1). Drops to ~0.5 for
     *  STALE / COMM_LOST tiers so the asset visibly recedes. Defaults to
     *  1 for the live tiers. The selected-state cyan halo isn't scaled
     *  by this — selection always pops. */
    opacityScale?: number;
}) {
    // Cylinder envelope: 15% taller and at the ring's outer radius. The
    // operator sees a faint cyan glow that just barely surrounds the
    // schematic instead of a disembodied prop next to it.
    const cylHeight = (selectedHeight ?? radius * 2) * 1.15;
    return (
        <>
            {/* Primary ring — flat on ground plane (Y up), thin annulus.
                2026-07-14: halved thickness (was inner=0.85, now 0.925).
                Original ring was 15% of the radius wide -- read as a
                deliberate ring, but visually competed with the schematic
                inside. 7.5% width is a subtler underscore that still
                carries the severity color at a glance without dominating. */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <ringGeometry args={[radius * 0.925, radius, 32]} />
                <meshBasicMaterial color={color} transparent opacity={0.85 * opacityScale} side={THREE.DoubleSide} />
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
    operationalState,
    tier,
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

    // Severity-driven ring color is the default. The 5-tier liveness
    // model overrides it on silent tiers: STALE -> slate (we expected
    // to hear from it, we didn't), COMM_LOST -> amber (we know why,
    // the edge link is down). Live tiers (ACTIVE/DEGRADED) keep the
    // severity color so the operator's "is it healthy?" read stays
    // intact. LOST is filtered upstream and shouldn't reach here.
    const TIER_RING_SLATE = '#64748b';   // tailwind slate-500
    const TIER_RING_AMBER = '#f59e0b';   // tailwind amber-500
    const TIER_RING_OPACITY_DIM = 0.45;

    let ring: string;
    let ringOpacityScale = 1;
    if (tier === 'STALE') {
        ring = TIER_RING_SLATE;
        ringOpacityScale = TIER_RING_OPACITY_DIM;
    } else if (tier === 'COMM_LOST') {
        ring = TIER_RING_AMBER;
        ringOpacityScale = TIER_RING_OPACITY_DIM;
    } else {
        ring = ringColor(severity, forceId);
    }

    // All per-platform geometry comes from lib/assetGeometry. See
    // __tests__/assetGeometry.test.ts for the load-bearing invariants
    // (every variant in ASSET_HEIGHT also has GROUND_OFFSET; launcher
    // pad height = groundOffset - hinge_native_bottom; etc.).
    //
    // effectiveScale folds in the per-variant visual-scale multiplier
    // so the schematic, pad, ring, footprint, and spotlight cylinder
    // all shrink/grow uniformly. Launchers carry a 0.6 multiplier to
    // bring their on-screen footprint in line with sensor schematics
    // at the same caller-supplied base scale.
    const effectiveScale = scale * resolveVariantScale(platformVariant);
    const liftedY = resolveGroundOffset(platformVariant) * effectiveScale;
    const padHeight = resolvePadHeight(platformVariant);
    const selectedCylHeight = resolveAssetHeight(platformVariant) * effectiveScale;
    const ringRadius = resolveRingRadius(platformVariant, effectiveScale);
    const padRadius = resolvePadWorldRadius(platformVariant, effectiveScale);

    // Fallback used by both Suspense (GLB load) and ErrorBoundary (render
    // crash). One source of truth so a GLB swap-out vs a buggy schematic
    // look identical to the operator. Uses the default ground offset
    // (UnknownPlatformBadge is centered at origin and the default value
    // is the octahedron's radius).
    const fallback = (
        <group position={[0, resolveGroundOffset(null) * effectiveScale, 0]} scale={effectiveScale}>
            <UnknownPlatformBadge degraded={false} variant={platformVariant ?? 'UNKNOWN'} />
        </group>
    );

    return (
        <group>
            <SeverityBaseRing
                color={ring}
                radius={ringRadius}
                selected={selected}
                selectedHeight={selectedCylHeight}
                opacityScale={ringOpacityScale}
            />
            {padHeight !== undefined && (
                <LaunchPad height={padHeight * effectiveScale} radius={padRadius} />
            )}
            <SchematicErrorBoundary fallback={fallback}>
                <Suspense fallback={fallback}>
                    {glbUrl ? (
                        <group position={[0, liftedY, 0]} scale={effectiveScale}>
                            <GlbModel url={glbUrl} scale={1} />
                        </group>
                    ) : SchematicComp ? (
                        <group position={[0, liftedY, 0]} scale={effectiveScale}>
                            <SchematicComp degraded={schematicDegraded} operationalState={operationalState} />
                        </group>
                    ) : (
                        fallback
                    )}
                </Suspense>
            </SchematicErrorBoundary>
        </group>
    );
}
