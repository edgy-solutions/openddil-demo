// =============================================================================
// MilitaryFacilitySchematic — fortified compound silhouette
// =============================================================================
// New schematic for the sensor scope expansion (ADR pending). Covers two
// ORBAT entries that share base geometry but differ in vertical detail:
//
//   * AIR_DEFENSE_SITE     — compound + control tower
//   * HEADQUARTER_COMPLEX  — compound + control tower + flagpole + tier
//                            indicator pad (the "HQ" variant)
//
// The HQ-vs-default distinction is one prop, not two schematic files —
// keeps the palette/silhouette family unified.
//
// Geometry: rectangular compound (5×6) + perimeter wall + central building
// with a control tower. HQ variant adds a flagpole + emissive cyan tier
// indicator on the tower roof.
//
// Degraded behavior: tower indicator and roof indicator flash amber.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps, FacilityVariant } from './types';

interface MilitaryFacilitySchematicProps extends SchematicProps {
  variant?: FacilityVariant;
}

export function MilitaryFacilitySchematic({
  degraded,
  variant = 'DEFAULT',
}: MilitaryFacilitySchematicProps) {
    const indicatorRefs = useRef<THREE.Mesh[]>([]);
    indicatorRefs.current = [];

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        indicatorRefs.current.forEach((mesh, i) => {
            if (!mesh) return;
            if (degraded) {
                (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b);
                (mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 6 + i) * 0.5;
            } else {
                (mesh.material as THREE.MeshBasicMaterial).color.setHex(0x10b981);
                (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
            }
        });
    });

    return (
        <group>
            {/* Compound pad — rectangular footprint, dark slate floor */}
            <mesh position={[0, -0.85, 0]}>
                <boxGeometry args={[5, 0.3, 6]} />
                <meshStandardMaterial color={0x0f172a} metalness={0.6} roughness={0.4} />
            </mesh>

            {/* Perimeter wall — slate-800, traces the compound edge */}
            <mesh position={[0, -0.55, 3]}>
                <boxGeometry args={[5, 0.4, 0.15]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[0, -0.55, -3]}>
                <boxGeometry args={[5, 0.4, 0.15]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[2.5, -0.55, 0]}>
                <boxGeometry args={[0.15, 0.4, 6]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[-2.5, -0.55, 0]}>
                <boxGeometry args={[0.15, 0.4, 6]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>

            {/* Cyan accent strip on the front wall — landmark for orientation */}
            <mesh position={[0, -0.4, 3.08]}>
                <boxGeometry args={[4.6, 0.04, 0.04]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} />
            </mesh>

            {/* Main building — slate-700, central */}
            <mesh position={[0, 0.5, -0.5]}>
                <boxGeometry args={[3, 1.6, 2]} />
                <meshStandardMaterial color={0x334155} metalness={0.5} roughness={0.5} />
            </mesh>

            {/* Building roof accent — emissive cyan strip */}
            <mesh position={[0, 1.32, -0.5]}>
                <boxGeometry args={[3.05, 0.04, 2.05]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.6} />
            </mesh>

            {/* Control tower — taller cylinder rising from one corner.
                Slate-600, lighter so it reads as a separate component. */}
            <mesh position={[1.0, 1.0, -0.5]}>
                <cylinderGeometry args={[0.35, 0.4, 2.6, 16]} />
                <meshStandardMaterial color={0x475569} metalness={0.6} roughness={0.4} />
            </mesh>

            {/* Tower top — health-aware indicator */}
            <mesh
                position={[1.0, 2.45, -0.5]}
                ref={(el) => { if (el) indicatorRefs.current.push(el); }}
            >
                <cylinderGeometry args={[0.42, 0.42, 0.2, 16]} />
                <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
            </mesh>

            {/* HQ variant adds flagpole + a second indicator on the roof */}
            {variant === 'HQ' && (
                <>
                    {/* Flagpole */}
                    <mesh position={[-1.2, 1.5, 0.5]}>
                        <cylinderGeometry args={[0.05, 0.05, 3.0, 8]} />
                        <meshStandardMaterial color={0x94a3b8} metalness={0.9} roughness={0.2} />
                    </mesh>
                    {/* Flag — cyan rectangle near top */}
                    <mesh position={[-0.9, 2.6, 0.5]}>
                        <boxGeometry args={[0.55, 0.4, 0.02]} />
                        <meshBasicMaterial color={0x22d3ee} transparent opacity={0.85} side={THREE.DoubleSide} />
                    </mesh>
                    {/* Roof indicator — second health-aware pad, distinguishes HQ
                        from a default site at a glance */}
                    <mesh
                        position={[-0.8, 1.36, -0.5]}
                        ref={(el) => { if (el) indicatorRefs.current.push(el); }}
                    >
                        <boxGeometry args={[0.6, 0.06, 0.6]} />
                        <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
                    </mesh>
                </>
            )}
        </group>
    );
}
