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

function SeverityBaseRing({ color, radius, selected }: {
    color: string;
    radius: number;
    selected?: boolean;
}) {
    return (
        <>
            {/* Primary ring — flat on ground plane (Y up), thin annulus */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <ringGeometry args={[radius * 0.85, radius, 32]} />
                <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} />
            </mesh>
            {/* Selected — additional bright outer ring for picker emphasis */}
            {selected && (
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
                    <ringGeometry args={[radius * 1.15, radius * 1.35, 32]} />
                    <meshBasicMaterial color="#22d3ee" transparent opacity={0.6} side={THREE.DoubleSide} />
                </mesh>
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

    // Fallback used by both Suspense (GLB load) and ErrorBoundary (render
    // crash). One source of truth so a GLB swap-out vs a buggy schematic
    // look identical to the operator.
    const fallback = (
        <group scale={scale}>
            <UnknownPlatformBadge degraded={false} variant={platformVariant ?? 'UNKNOWN'} />
        </group>
    );

    return (
        <group>
            <SeverityBaseRing color={ring} radius={Math.max(1, 3 * scale)} selected={selected} />
            <SchematicErrorBoundary fallback={fallback}>
                <Suspense fallback={fallback}>
                    {glbUrl ? (
                        <group scale={scale}>
                            <GlbModel url={glbUrl} scale={1} />
                        </group>
                    ) : SchematicComp ? (
                        <group scale={scale}>
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
