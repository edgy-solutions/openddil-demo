// =============================================================================
// ArtillerySchematic — pod-on-hinge launcher silhouette
// =============================================================================
// Extracted from DiagnosticCanvas.tsx. Used by:
//   * Maintainer view — single artillery platform close-up
//   * SCHEMATIC_REGISTRY — covers all 4 interceptor tiers (CUAS / VSHORAD /
//     SHORAD / MRAD) plus the generic MISSILE_LAUNCHER. The base silhouette
//     is the same launcher pod for all; tier differentiation in the cascade
//     happens via the AssetVisual's base ring color and label, not by
//     mutating the schematic.
//
// Geometry: hinge base (4×1×4) + tilted pod (4.5×3.5×7) at Y≈+0.5,
// rotating gently on X-axis when nominal (idle scan). 6 tube indicators
// on the front face.
//
// Degraded behavior: pod stops rotating; first 2 tube indicators flash
// amber; hinge tints amber.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps } from './types';

export function ArtillerySchematic({ degraded }: SchematicProps) {
    const hingeRef = useRef<THREE.Mesh>(null);
    const podRef = useRef<THREE.Group>(null);
    const indicatorRefs = useRef<THREE.Mesh[]>([]);
    indicatorRefs.current = [];

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (podRef.current) {
            if (!degraded) {
                podRef.current.rotation.x = Math.sin(time * 0.5) * 0.2 + 0.5;
            }
        }
        if (hingeRef.current && degraded) {
            (hingeRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b);
        } else if (hingeRef.current) {
            (hingeRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x334155);
        }

        indicatorRefs.current.forEach((mesh, i) => {
            if (mesh) {
                if (degraded && i < 2) {
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b);
                    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 8) * 0.5;
                } else {
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(0x10b981);
                    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
                }
            }
        });
    });

    return (
        <group>
            {/* Hinge */}
            <mesh ref={hingeRef} position={[0, -2, 0]}>
                <boxGeometry args={[4, 1, 4]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.7} roughness={0.3} />
            </mesh>

            <group ref={podRef} position={[0, -1.5, 0]}>
                {/* Solid Pod Form */}
                <mesh position={[0, 2, 0]}>
                    <boxGeometry args={[4.5, 3.5, 7]} />
                    <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
                </mesh>

                {/* Subtle Schematic Overlay */}
                <mesh position={[0, 2, 0]}>
                    <boxGeometry args={[4.52, 3.52, 7.02]} />
                    <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
                </mesh>

                {/* Facade Grid (Launch Status for 6 tubes) */}
                <group position={[0, 2, 3.55]}>
                    {[[-1, 0.8], [1, 0.8], [-1, 0], [1, 0], [-1, -0.8], [1, -0.8]].map((pos, i) => (
                        <group key={i} position={[pos[0], pos[1], 0]}>
                            {/* Outer tube ring */}
                            <mesh rotation={[Math.PI / 2, 0, 0]}>
                                <cylinderGeometry args={[0.6, 0.6, 0.1, 16]} />
                                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                            </mesh>
                            {/* Indicator element */}
                            <mesh
                                position={[0, 0, 0.06]}
                                ref={(el) => { if (el) indicatorRefs.current.push(el); }}
                            >
                                <boxGeometry args={[0.4, 0.4, 0.05]} />
                                <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
                            </mesh>
                        </group>
                    ))}
                </group>

                {/* Side Panels */}
                <group position={[2.26, 2, 0]} rotation={[0, Math.PI / 2, 0]}>
                    {Array.from({ length: 4 }).map((_, row) => (
                        Array.from({ length: 8 }).map((_, col) => (
                            <mesh key={`side-${row}-${col}`} position={[-2.5 + col * 0.7, -1 + row * 0.65, 0]}>
                                <boxGeometry args={[0.4, 0.4, 0.05]} />
                                <meshBasicMaterial color={0x0ea5e9} transparent opacity={0.3} />
                            </mesh>
                        ))
                    ))}
                </group>
            </group>
        </group>
    );
}

// Legacy export alias for maintainer-view imports.
export { ArtillerySchematic as Artillery };
