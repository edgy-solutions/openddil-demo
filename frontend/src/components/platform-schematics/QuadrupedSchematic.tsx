// =============================================================================
// QuadrupedSchematic — articulated quadruped robot / UGV silhouette
// =============================================================================
// Extracted from DiagnosticCanvas.tsx. Used by:
//   * Maintainer view — single quadruped platform close-up
//   * SCHEMATIC_REGISTRY — currently mapped to AH-64E as a placeholder
//     until a helicopter schematic is sourced. Note this is a known visual
//     mismatch (Apache ≠ quadruped); flagged in the registry comment.
//
// Geometry: capsule torso (rotated 90° about Z) at Y=3.5 + 4 articulated
// legs hanging down to Y≈-0.7. One leg (rear-left) is the "anomaly point"
// with an additive-blending core that pulses cyan/red.
//
// Degraded behavior: anomaly-leg core glows red and pulses faster; every
// 5th body-grid indicator goes red.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps } from './types';

export function QuadrupedSchematic({ degraded }: SchematicProps) {
    const anomalyCoreRef = useRef<THREE.Mesh>(null);
    const indicatorRefs = useRef<THREE.Mesh[]>([]);
    indicatorRefs.current = [];

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (anomalyCoreRef.current) {
            if (degraded) {
                (anomalyCoreRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xef4444);
                (anomalyCoreRef.current.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(time * 10) * 0.4;
            } else {
                (anomalyCoreRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x22d3ee);
                (anomalyCoreRef.current.material as THREE.MeshBasicMaterial).opacity = 0.8;
            }
        }

        indicatorRefs.current.forEach((mesh, i) => {
            if (mesh) {
                if (degraded && i % 5 === 0) {
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xef4444);
                } else {
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(0x10b981);
                }
                (mesh.material as THREE.MeshBasicMaterial).opacity = 0.4 + Math.sin(time * 2 + i) * 0.3;
            }
        });
    });

    const legs = [
        { pos: [1.5, 3.5, -1.3], isRear: false, isAnomaly: false }, // Front Left
        { pos: [1.5, 3.5, 1.3], isRear: false, isAnomaly: false },  // Front Right
        { pos: [-1.5, 3.5, -1.3], isRear: true, isAnomaly: true },  // Rear Left (Anomaly point)
        { pos: [-1.5, 3.5, 1.3], isRear: true, isAnomaly: false }   // Rear Right
    ];

    return (
        <group>
            {/* Torso Pod */}
            <group position={[0, 3.5, 0]} rotation={[0, 0, Math.PI / 2]}>
                <mesh>
                    <capsuleGeometry args={[1.2, 3, 32, 32]} />
                    <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
                </mesh>
                {/* Subtle Schematic Overlay */}
                <mesh>
                    <capsuleGeometry args={[1.22, 3, 16, 16]} />
                    <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
                </mesh>
            </group>

            {/* Heat Map Grids (Subtle clusters near leg connections) */}
            {[-1.2, 1.2].map((x, i) => (
                [-0.8, 0.8].map((z, j) => (
                    <group key={`grid-${i}-${j}`} position={[x, 4.65, z]} rotation={[-Math.PI / 2, 0, 0]}>
                        {Array.from({ length: 2 }).map((_, row) => (
                            Array.from({ length: 3 }).map((_, col) => (
                                <mesh
                                    key={`pad-${row}-${col}`}
                                    position={[-0.2 + col * 0.2, -0.1 + row * 0.2, 0]}
                                    ref={(el) => { if (el) indicatorRefs.current.push(el); }}
                                >
                                    <boxGeometry args={[0.15, 0.15, 0.05]} />
                                    <meshBasicMaterial color={0x10b981} transparent opacity={0.6} />
                                </mesh>
                            ))
                        ))}
                    </group>
                ))
            ))}

            {/* Articulated Legs */}
            {legs.map((leg, i) => (
                <group key={i} position={leg.pos as [number, number, number]}>
                    {/* Hip Motor */}
                    {leg.isAnomaly ? (
                        <mesh ref={anomalyCoreRef} rotation={[Math.PI / 2, 0, 0]}>
                            <cylinderGeometry args={[0.4, 0.4, 0.6, 32]} />
                            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.8} blending={THREE.AdditiveBlending} />
                        </mesh>
                    ) : (
                        <mesh rotation={[Math.PI / 2, 0, 0]}>
                            <cylinderGeometry args={[0.35, 0.35, 0.5, 32]} />
                            <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                        </mesh>
                    )}

                    {/* Thigh */}
                    <group rotation={[0, 0, -Math.PI / 6]}>
                        <mesh position={[0, -0.8, 0]}>
                            <cylinderGeometry args={[0.2, 0.15, 1.6, 16]} />
                            <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
                        </mesh>
                        <mesh position={[0, -0.8, 0]}>
                            <cylinderGeometry args={[0.21, 0.16, 1.6, 8]} />
                            <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
                        </mesh>

                        {/* Knee Motor */}
                        <mesh position={[0, -1.6, 0]} rotation={[Math.PI / 2, 0, 0]}>
                            <cylinderGeometry args={[0.25, 0.25, 0.4, 32]} />
                            <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                        </mesh>

                        {/* Shin */}
                        <group position={[0, -1.6, 0]} rotation={[0, 0, Math.PI / 6]}>
                            <mesh position={[0, -0.8, 0]}>
                                <cylinderGeometry args={[0.15, 0.1, 1.6, 16]} />
                                <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
                            </mesh>
                            <mesh position={[0, -0.8, 0]}>
                                <cylinderGeometry args={[0.16, 0.11, 1.6, 8]} />
                                <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
                            </mesh>

                            {/* Foot Pad */}
                            <mesh position={[0, -1.6, 0]}>
                                <boxGeometry args={[0.4, 0.2, 0.4]} />
                                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                            </mesh>
                        </group>
                    </group>
                </group>
            ))}
        </group>
    );
}

// Legacy export alias for maintainer-view imports.
export { QuadrupedSchematic as Quadruped };
