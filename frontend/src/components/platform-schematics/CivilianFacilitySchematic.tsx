// =============================================================================
// CivilianFacilitySchematic — neutral civilian installation silhouette
// =============================================================================
// New schematic for the sensor scope expansion (ADR pending). Covers
// INSTALLATION_FACILITY_CIVILIAN from the ORBAT enum.
//
// Visual contract: this entity reads as "civilian/non-combatant" at a
// glance. Different from the military facility:
//   * Lighter palette (slate-500 building vs slate-700 — visibly less
//     fortified)
//   * No perimeter wall
//   * No control tower
//   * Roof cross marker (medical/civilian convention) — single
//     decorative landmark that reads as "non-military"
//
// Geometry: pad + low building + cross-shaped roof marker.
//
// Degraded behavior: roof-marker pulses amber. Otherwise identical
// silhouette.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps } from './types';

export function CivilianFacilitySchematic({ degraded }: SchematicProps) {
    const markerRef = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (markerRef.current) {
            if (degraded) {
                (markerRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b);
                (markerRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 6) * 0.5;
            } else {
                (markerRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x94a3b8);
                (markerRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85;
            }
        }
    });

    return (
        <group>
            {/* Pad — rectangular footprint, slate-900 like other facilities
                so it sits in the same family. */}
            <mesh position={[0, -0.85, 0]}>
                <boxGeometry args={[4.5, 0.25, 5]} />
                <meshStandardMaterial color={0x0f172a} metalness={0.5} roughness={0.5} />
            </mesh>

            {/* Building — wider but lower than the military variant. Slate-500
                so it reads visibly lighter (civilian = less hardened). */}
            <mesh position={[0, 0.0, 0]}>
                <boxGeometry args={[3.5, 1.4, 3.5]} />
                <meshStandardMaterial color={0x64748b} metalness={0.4} roughness={0.6} />
            </mesh>

            {/* Roof — slightly larger to give a visible roof line */}
            <mesh position={[0, 0.78, 0]}>
                <boxGeometry args={[3.7, 0.1, 3.7]} />
                <meshStandardMaterial color={0x475569} metalness={0.5} roughness={0.5} />
            </mesh>

            {/* Roof cross marker — two crossed bars. Reads as the civilian /
                medical convention at small scale. Health-aware via materialRef. */}
            <mesh ref={markerRef} position={[0, 0.84, 0]}>
                <boxGeometry args={[1.6, 0.05, 0.3]} />
                <meshBasicMaterial color={0x94a3b8} transparent opacity={0.85} />
            </mesh>
            <mesh position={[0, 0.84, 0]}>
                <boxGeometry args={[0.3, 0.05, 1.6]} />
                <meshBasicMaterial color={0x94a3b8} transparent opacity={0.85} />
            </mesh>

            {/* Window strip on the front face — landmark for orientation,
                purely cosmetic. Cyan dim accent, less aggressive than the
                military variant's. */}
            <mesh position={[0, 0.1, 1.78]}>
                <boxGeometry args={[2.4, 0.3, 0.04]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.35} />
            </mesh>
        </group>
    );
}
