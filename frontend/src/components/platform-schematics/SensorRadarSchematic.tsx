// =============================================================================
// SensorRadarSchematic — radar dish + tower silhouette, tier-parameterized
// =============================================================================
// New schematic added for the sensor scope expansion (ADR pending). Covers
// all 4 sensor tiers in the customer ORBAT enum (CUAS / VSHORAD / SHORAD /
// MRAD). One silhouette, four tiers — the AssetVisual's base ring + label
// distinguishes tiers in the COP rather than mutating the mesh.
//
// Geometry: stationary base box + central tower + tilted dish on a yaw
// platform that rotates slowly when nominal. Tier prop scales the dish
// (CUAS small → MRAD large) — radar dish size is the one visual cue that
// reads as "range tier" without a label.
//
// Degraded behavior: dish stops rotating; tower top indicator flashes amber.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps, SensorTier } from './types';

interface SensorRadarSchematicProps extends SchematicProps {
  tier?: SensorTier;
}

// Per-tier dish radius — visual differentiation without changing palette
// or silhouette. Ratios chosen so SHORAD is "default normal" and MRAD is
// visibly bigger, CUAS visibly smaller. Tune during regional QA pass.
const DISH_RADIUS_BY_TIER: Record<SensorTier, number> = {
    CUAS:     0.9,
    VSHORAD:  1.15,
    SHORAD:   1.4,
    MRAD:     1.8,
};

export function SensorRadarSchematic({ degraded, tier = 'SHORAD', operationalState }: SensorRadarSchematicProps) {
    const yawRef = useRef<THREE.Group>(null);
    const indicatorRef = useRef<THREE.Mesh>(null);
    const dishRadius = DISH_RADIUS_BY_TIER[tier];

    // Phase 5: derive op-state visual modifiers. Each check is null-safe so
    // pre-ADR-0026 producers (operationalState undefined or all-null) fall
    // through to the original nominal-vs-degraded behavior driven by
    // `degraded` alone.
    const powerOff = operationalState?.power_state === 'POWER_STATE_OFF'
                  || operationalState?.power_state === 'POWER_STATE_SHUTTING_DOWN';
    const maintenance = operationalState?.power_state === 'POWER_STATE_MAINTENANCE';
    const healthFault = operationalState?.health_state === 'HEALTH_STATE_FAULT'
                     || operationalState?.health_state === 'HEALTH_STATE_FAILED';

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        // Dish rotation: pauses on POWER_STATE_OFF, MAINTENANCE, or degraded.
        // POWER_OFF and MAINTENANCE communicate "intentionally not scanning"
        // — distinct from the wobble that `degraded` might suggest. The mesh
        // is the same; the absence of motion is the signal.
        if (yawRef.current && !degraded && !powerOff && !maintenance) {
            yawRef.current.rotation.y = time * 0.4;  // gentle scan
        }
        if (indicatorRef.current) {
            const mat = indicatorRef.current.material as THREE.MeshBasicMaterial;
            if (powerOff) {
                // All-off: indicator goes dark slate, no strobe.
                mat.color.setHex(0x334155);
                mat.opacity = 0.3;
            } else if (healthFault) {
                // Active fault: red strobe, faster than degraded amber.
                mat.color.setHex(0xef4444);
                mat.opacity = 0.4 + Math.sin(time * 12) * 0.6;
            } else if (degraded) {
                mat.color.setHex(0xf59e0b);
                mat.opacity = 0.5 + Math.sin(time * 8) * 0.5;
            } else {
                mat.color.setHex(0x10b981);
                mat.opacity = 0.8;
            }
        }
    });

    return (
        <group>
            {/* Base — square footprint, dark slate. Same palette family as
                the existing schematics so the radar reads as the same
                visual lineage. */}
            <mesh position={[0, -0.8, 0]}>
                <boxGeometry args={[2.4, 0.6, 2.4]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>

            {/* Subtle base-cyan accent ring at the base/tower seam */}
            <mesh position={[0, -0.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <ringGeometry args={[1.0, 1.18, 32]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.55} side={THREE.DoubleSide} />
            </mesh>

            {/* Central tower — slate-700, lighter than base */}
            <mesh position={[0, 0.2, 0]}>
                <cylinderGeometry args={[0.35, 0.45, 1.6, 16]} />
                <meshStandardMaterial color={0x334155} metalness={0.6} roughness={0.4} />
            </mesh>

            {/* Tower-top indicator pad — health-aware */}
            <mesh ref={indicatorRef} position={[0, 1.05, 0]}>
                <cylinderGeometry args={[0.18, 0.18, 0.08, 16]} />
                <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
            </mesh>

            {/* Yaw platform with the dish — rotates when nominal */}
            <group ref={yawRef} position={[0, 1.2, 0]}>
                {/* Dish — paraboloid approximation via a thin cone segment
                    tilted to face skyward. Tier-scaled radius. */}
                <mesh rotation={[-Math.PI / 4, 0, 0]} position={[0, 0.2, dishRadius * 0.4]}>
                    <coneGeometry args={[dishRadius, 0.25, 24, 1, true]} />
                    <meshStandardMaterial
                        color={0x0f172a}
                        metalness={0.8}
                        roughness={0.2}
                        side={THREE.DoubleSide}
                    />
                </mesh>

                {/* Dish rim — emissive cyan ring traces the leading edge */}
                <mesh rotation={[-Math.PI / 4, 0, 0]} position={[0, 0.32, dishRadius * 0.4]}>
                    <ringGeometry args={[dishRadius * 0.95, dishRadius, 32]} />
                    <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} side={THREE.DoubleSide} />
                </mesh>

                {/* Dish backbone — thin bar across the back of the dish */}
                <mesh rotation={[-Math.PI / 4, 0, 0]} position={[0, 0.2, dishRadius * 0.4]}>
                    <boxGeometry args={[dishRadius * 1.9, 0.05, 0.05]} />
                    <meshBasicMaterial color={0x475569} />
                </mesh>
            </group>
        </group>
    );
}
