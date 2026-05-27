// =============================================================================
// LaserShoradSchematic — vertical-cylinder laser-emplacement silhouette
// =============================================================================
// Extracted from DiagnosticCanvas.tsx (originally maintainer-tier only).
// Now also used by regional/HQ 3D maps via SCHEMATIC_REGISTRY for any
// platform_variant that resolves to this shape.
//
// Geometry: dark slate cylinder (radius 1.4, height 8) with a circular
// facade grid of 96 indicator pads (8 rows × 12 columns). Vertical
// orientation — Y is up, extends from Y≈-4 to Y≈+4.
//
// Degraded behavior: indicator pads cycle amber/red instead of emerald;
// every third pad gets the brighter "overheat" red. No silhouette change.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps } from './types';

export function LaserShoradSchematic({ degraded }: SchematicProps) {
    const coreRef = useRef<THREE.Group>(null);
    const indicatorRefs = useRef<THREE.Mesh[]>([]);
    indicatorRefs.current = [];

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        indicatorRefs.current.forEach((mesh, i) => {
            if (mesh) {
                if (degraded) {
                    const isOverheat = i % 3 === 0;
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(isOverheat ? 0xef4444 : 0xf59e0b);
                    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(time * 5 + i) * 0.4;
                } else {
                    (mesh.material as THREE.MeshBasicMaterial).color.setHex(0x10b981);
                    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
                }
            }
        });
    });

    return (
        <group>
            {/* Substantive Solid Cylinder */}
            <mesh position={[0, 0, 0]}>
                <cylinderGeometry args={[1.4, 1.4, 8, 32]} />
                <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
            </mesh>

            {/* Subtle Schematic Overlay */}
            <mesh position={[0, 0, 0]}>
                <cylinderGeometry args={[1.41, 1.41, 8, 16]} />
                <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
            </mesh>

            {/* Circular Facade Grid */}
            <group ref={coreRef}>
                {Array.from({ length: 8 }).map((_, row) => (
                    Array.from({ length: 12 }).map((_, col) => {
                        const angle = (col / 12) * Math.PI * 2;
                        const y = -3 + row * 0.85;
                        const x = Math.cos(angle) * 1.45;
                        const z = Math.sin(angle) * 1.45;
                        return (
                            <mesh
                                key={`${row}-${col}`}
                                position={[x, y, z]}
                                rotation={[0, -angle + Math.PI / 2, 0]}
                                ref={(el) => { if (el) indicatorRefs.current.push(el); }}
                            >
                                <boxGeometry args={[0.4, 0.4, 0.05]} />
                                <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
                            </mesh>
                        );
                    })
                ))}
            </group>
        </group>
    );
}

// Legacy export alias for maintainer-view imports that haven't been migrated.
// Once DiagnosticCanvas.tsx is updated to use the new name, this can go.
export { LaserShoradSchematic as LaserShorad };
