// =============================================================================
// UnknownPlatformBadge — final-fallback "unrecognized platform" marker
// =============================================================================
// Used by the AssetVisual cascade when:
//   * The asset's platform_variant doesn't match any GLB or schematic
//     registry entry, OR
//   * A GLB or schematic threw at render time (ErrorBoundary fallback)
//
// Visual contract: must read as HONEST UNCERTAINTY, not as a stylistic
// choice. The shape is deliberately a labeled wireframe octahedron — no
// other entity in the cascade uses this shape, so it's unmistakeable.
//
// We DO NOT fall through to any specific platform schematic for unknowns
// because misrepresenting an LTAMDS or a civilian facility as something
// it isn't is more misleading than rendering a clearly-flagged unknown.
//
// Severity is encoded in the AssetVisual's base ring (always visible
// beneath the badge), so an unknown asset still surfaces severity even
// when we can't draw the platform.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SchematicProps } from './types';

interface UnknownPlatformBadgeProps extends SchematicProps {
  /** The unrecognized variant string — currently rendered as a wireframe-only
   *  cue, not as text. A Phase 5 detail-panel could surface the variant
   *  string textually; for now the wireframe-octahedron shape IS the signal. */
  variant?: string;
}

export function UnknownPlatformBadge({ degraded: _degraded, variant: _variant }: UnknownPlatformBadgeProps) {
    const wireRef = useRef<THREE.Mesh>(null);
    const coreRef = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (wireRef.current) {
            wireRef.current.rotation.y = time * 0.5;
            wireRef.current.rotation.x = time * 0.3;
        }
        if (coreRef.current) {
            // Gentle pulse — reads as "alive but unidentified"
            (coreRef.current.material as THREE.MeshBasicMaterial).opacity =
                0.3 + Math.sin(time * 2) * 0.15;
        }
    });

    return (
        <group>
            {/* Wireframe shell — slowly tumbles. Slate-400 reads as "no claim";
                not the alarming red of severed or the green of nominal. */}
            <mesh ref={wireRef}>
                <octahedronGeometry args={[1.6, 0]} />
                <meshBasicMaterial color={0x94a3b8} wireframe transparent opacity={0.7} />
            </mesh>

            {/* Subtle inner core — slate-500 solid, very dim. Gives the
                wireframe a center of mass instead of feeling hollow. */}
            <mesh ref={coreRef}>
                <octahedronGeometry args={[0.8, 0]} />
                <meshBasicMaterial color={0x64748b} transparent opacity={0.3} />
            </mesh>
        </group>
    );
}
