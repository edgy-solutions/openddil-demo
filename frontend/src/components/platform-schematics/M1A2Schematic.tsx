// =============================================================================
// M1A2Schematic — M1A2-class tracked tank silhouette
// =============================================================================
// Extracted from DiagnosticCanvas.tsx (originally `VehicleClassSchematic`,
// renamed to match its actual class — it's tank-shaped, not "vehicle-class").
// Used by:
//   * Maintainer view — GROUND DIAGNOSTICS panel for M1A2 SEPv2/v3 fleet
//   * SCHEMATIC_REGISTRY — keyed under "M1A2-SEPv3" (and aliased for SEPv2
//     when present). NOT a universal "any ground vehicle" fallback — falling
//     a non-tank platform through to this would draw it as a tank.
//
// Geometry: extruded side-profile hull (glacis + rear taper baked into the
// silhouette) + track skirts + turret + main-gun barrel. ~7 units long, ~6
// wide, sits centered at Y≈0. Stationary by design — no rotation animation.
//
// Degraded behavior: indicator-strip first 2 pads flash amber. No silhouette
// change.

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { SchematicProps } from './types';

export function M1A2Schematic({ degraded }: SchematicProps) {
    const indicatorRefs = useRef<THREE.Mesh[]>([]);
    indicatorRefs.current = [];

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        indicatorRefs.current.forEach((mesh, i) => {
            if (!mesh) return;
            if (degraded && i < 2) {
                (mesh.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b);
                (mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(time * 6 + i) * 0.4;
            } else {
                (mesh.material as THREE.MeshBasicMaterial).color.setHex(0x10b981);
                (mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
            }
        });
    });

    // Hull side-profile, extruded along width. Carries the glacis (front
    // slope) and rear taper built into the silhouette so no detached plate
    // mesh is needed — the box-shape problem is solved by the geometry,
    // not by stuck-on decoration. Coordinates: X = forward, Y = up.
    const sideProfile = useMemo(() => {
        const s = new THREE.Shape();
        s.moveTo(-4, -0.8);      // rear-bottom
        s.lineTo(4, -0.8);       // front-bottom (lower nose)
        s.lineTo(4, -0.1);       // front-bottom rises slightly (lower glacis)
        s.lineTo(2.4, 0.85);     // glacis crests at deck level
        s.lineTo(-3.7, 0.85);    // deck rear
        s.lineTo(-4, 0.3);       // rear-top tapers down
        s.closePath();
        return s;
    }, []);

    return (
        <group>
            {/* Hull — extruded side profile (glacis + rear taper built in). */}
            <mesh rotation={[0, -Math.PI / 2, 0]} position={[2.5, 0, 0]}>
                <extrudeGeometry args={[sideProfile, {
                    depth: 5,
                    bevelEnabled: true,
                    bevelThickness: 0.10,
                    bevelSize: 0.10,
                    bevelSegments: 2,
                }]} />
                <meshStandardMaterial color={0x0f172a} metalness={0.7} roughness={0.3} />
            </mesh>

            {/* Deck centerline accent */}
            <mesh position={[0, 0.97, -0.4]}>
                <boxGeometry args={[0.12, 0.05, 6.5]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} />
            </mesh>

            {/* Glacis-crest accent */}
            <mesh position={[0, 0.93, 2.4]}>
                <boxGeometry args={[4.6, 0.06, 0.08]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} />
            </mesh>

            {/* Track skirts */}
            <RoundedBox args={[0.4, 0.8, 7.4]} radius={0.15} smoothness={3} position={[2.85, -0.5, 0]}>
                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
            </RoundedBox>
            <RoundedBox args={[0.4, 0.8, 7.4]} radius={0.15} smoothness={3} position={[-2.85, -0.5, 0]}>
                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
            </RoundedBox>

            {/* Turret */}
            <mesh position={[0, 1.45, -0.5]}>
                <cylinderGeometry args={[1.5, 1.7, 0.85, 32]} />
                <meshStandardMaterial color={0x334155} metalness={0.6} roughness={0.4} />
            </mesh>

            {/* Turret-base accent ring */}
            <mesh position={[0, 1.03, -0.5]} rotation={[Math.PI / 2, 0, 0]}>
                <ringGeometry args={[1.65, 1.85, 48]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.55} side={THREE.DoubleSide} />
            </mesh>

            {/* Main gun barrel */}
            <mesh position={[0, 1.45, 2.5]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.18, 0.18, 4.5, 12]} />
                <meshStandardMaterial color={0x475569} metalness={0.9} roughness={0.2} />
            </mesh>

            {/* Indicator strip — 6 status pads on the side panel */}
            <group position={[2.95, 0.2, 0]} rotation={[0, Math.PI / 2, 0]}>
                {Array.from({ length: 6 }).map((_, col) => (
                    <mesh
                        key={`indicator-${col}`}
                        position={[-2.5 + col * 1.0, 0, 0]}
                        ref={(el) => { if (el) indicatorRefs.current.push(el); }}
                    >
                        <boxGeometry args={[0.4, 0.4, 0.05]} />
                        <meshBasicMaterial color={0x10b981} transparent opacity={0.8} />
                    </mesh>
                ))}
            </group>

            {/* Same indicator strip on the opposite side, cosmetic */}
            <group position={[-2.95, 0.2, 0]} rotation={[0, -Math.PI / 2, 0]}>
                {Array.from({ length: 6 }).map((_, col) => (
                    <mesh key={`indicator-r-${col}`} position={[-2.5 + col * 1.0, 0, 0]}>
                        <boxGeometry args={[0.4, 0.4, 0.05]} />
                        <meshBasicMaterial color={0x0ea5e9} transparent opacity={0.3} />
                    </mesh>
                ))}
            </group>
        </group>
    );
}

// Legacy export alias for maintainer-view imports referring to the original
// (broader) name. Once DiagnosticCanvas.tsx is updated to use M1A2Schematic
// directly, this can go.
export { M1A2Schematic as VehicleClassSchematic };
