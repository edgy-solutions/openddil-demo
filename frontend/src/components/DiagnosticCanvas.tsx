// =============================================================================
// DiagnosticCanvas — 3D asset diagnostic schematics (maintainer-tier view)
// =============================================================================
// Routes by assetType to the matching 3D schematic. Visual chrome (cyan
// bezel, scanning-line drift, glitch-text headers) comes from HudFrame so
// every maintainer-tier 3D surface reads as the same family.
//
// DEMO_MOCK: synthetic 3D schematics. None are wired to per-platform
// telemetry yet — the RADAR branch delegates to SensorArrayView (which
// carries its own banner via the LTAMDS config); the other branches
// render synthetic schematics with no data input. Full rewiring to the
// pipeline's per-platform telemetry is future work once schemas for
// those platforms are flowing. See ADR-0017.
import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import SensorArrayView, { LTAMDS_CONFIG } from './SensorArrayView';
import HudFrame from './HudFrame';
import { useTransitPhase, transitClass } from './EdgeTransit';

const DEMO_MOCK = true;

export function LaserShorad({ degraded }: { degraded: boolean }) {
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

export function Artillery({ degraded }: { degraded: boolean }) {
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

export function Quadruped({ degraded }: { degraded: boolean }) {
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

// VehicleClassSchematic — solid-bodied placeholder for the ground-vehicle
// class (M1A2 et al. — anything without a dedicated per-platform schematic).
// Reads as "intentional placeholder for vehicle class," not as "spinning
// fallback void." Uses the same palette and material discipline as
// Artillery/LaserShorad: dark slate housing + subtle cyan wireframe
// overlay + indicator strip on a side panel. No rotation animation by
// design — stationary reads as deliberate, not as a placeholder twitch.
function VehicleClassSchematic({ degraded }: { degraded: boolean }) {
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

    // Production palette — graduated slates (hull darkest → turret →
    // barrel lightest) for contrast, cyan/emerald accents for landmarks.
    // Matches the Artillery / LaserShorad / Quadruped palette family.
    // Positions and bevel sizes were verified component-by-component in
    // the debug-color iteration; only colors changed below.
    return (
        <group>
            {/* Hull — extruded side profile (glacis + rear taper built in).
                Dark slate-900 matches the other schematics' housing. */}
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

            {/* Deck centerline accent — thin emissive cyan bar running the
                length of the hull, gives the eye a landmark across the
                top surface. */}
            <mesh position={[0, 0.97, -0.4]}>
                <boxGeometry args={[0.12, 0.05, 6.5]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} />
            </mesh>

            {/* Glacis-crest accent — thin emissive cyan bar across the top
                of the front slope, defines the front edge clearly. */}
            <mesh position={[0, 0.93, 2.4]}>
                <boxGeometry args={[4.6, 0.06, 0.08]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.7} />
            </mesh>

            {/* Track skirts — slate-800 (one shade lighter than hull) so
                they read as a separate component. RoundedBox for chamfered
                ends; X=±2.85 clears the hull-bevel envelope. */}
            <RoundedBox args={[0.4, 0.8, 7.4]} radius={0.15} smoothness={3} position={[2.85, -0.5, 0]}>
                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
            </RoundedBox>
            <RoundedBox args={[0.4, 0.8, 7.4]} radius={0.15} smoothness={3} position={[-2.85, -0.5, 0]}>
                <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
            </RoundedBox>

            {/* Turret — slate-700, two shades lighter than the hull so it
                clearly rises above. Y=1.45 places the bottom (Y=1.025)
                above the hull-bevel-top. */}
            <mesh position={[0, 1.45, -0.5]}>
                <cylinderGeometry args={[1.5, 1.7, 0.85, 32]} />
                <meshStandardMaterial color={0x334155} metalness={0.6} roughness={0.4} />
            </mesh>

            {/* Turret-base accent ring — cyan structural seam at the
                turret/hull boundary. Single ring, not a full wireframe
                overlay (avoids the meridian-line "accidental seams"
                effect a wireframe on a featureless cylinder produces). */}
            <mesh position={[0, 1.03, -0.5]} rotation={[Math.PI / 2, 0, 0]}>
                <ringGeometry args={[1.65, 1.85, 48]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.55} side={THREE.DoubleSide} />
            </mesh>

            {/* Main gun barrel — slate-600, lighter still so the slim
                cylinder is visible against the turret/hull behind it. */}
            <mesh position={[0, 1.45, 2.5]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.18, 0.18, 4.5, 12]} />
                <meshStandardMaterial color={0x475569} metalness={0.9} roughness={0.2} />
            </mesh>

            {/* Indicator strip — 6 status pads on the side panel,
                health-aware (matches Artillery's tube-indicator pattern).
                Moved to X=±2.95 to sit clearly outboard of the hull-bevel
                envelope (±2.6) and outside the track skirts. */}
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

const KNOWN_SCHEMATICS = ['LASER_SHORAD', 'ARTILLERY', 'QUADRUPED'];

// Headers track the maintainer-tier framing: "Ground Diagnostics" for the
// ground-vehicle class (the VehicleClassSchematic fallback), and the
// existing `{assetType} DIAGNOSTICS` pattern for the dedicated schematics.
// LTAMDS keeps its own title from LTAMDS_CONFIG (renders via SensorArrayView).
function headerForAsset(assetType: string, hasDedicatedSchematic: boolean): { title: string, subtitle: string } {
    if (hasDedicatedSchematic) {
        return {
            title: `${assetType} DIAGNOSTICS`,
            subtitle: 'ENGINEERING SCHEMATIC // SYNTHETIC',
        };
    }
    return {
        title: 'GROUND DIAGNOSTICS',
        subtitle: `${assetType} // SYNTHETIC PLACEHOLDER`,
    };
}

export default function DiagnosticCanvas({
    assetType,
    degraded,
    coreTemp,
    transitTriggerKey,
}: {
    assetType: string,
    degraded: boolean,
    coreTemp: number,
    // Phase 6c.3 — when this key changes (the selectedEdge from
    // MaintainerApp), the schematic Canvas runs a transit animation.
    // First-mount and same-key re-renders do NOT trigger. Asset
    // changes within an edge don't trigger because the parent passes
    // the edge id, not the asset id.
    transitTriggerKey?: string | null,
}) {
    // Hook runs on every render; gating is internal (first-mount + same-
    // key checks). Safe to call before the RADAR-branch early-return.
    const transitPhase = useTransitPhase(transitTriggerKey ?? null);

    if (assetType === 'RADAR') {
        // Sensor-array class. LTAMDS is the only config shipped today; the
        // claim that this could carry other arrays becomes provable when a
        // second config arrives.
        // §C.3 TODO: SensorArrayView bypasses HudFrame so cycle-1
        // animation does NOT apply to RADAR-class schematics. Acceptable
        // for now — the demo's M1A2-SEPv3 fleet renders via the
        // VehicleClassSchematic path below (HudFrame-wrapped). If a
        // RADAR-class asset becomes demo-relevant later, lift the
        // contentClassName seam into SensorArrayView too.
        return <SensorArrayView degraded={degraded} coreTemp={coreTemp} config={LTAMDS_CONFIG} />;
    }
    const hasDedicatedSchematic = KNOWN_SCHEMATICS.includes(assetType);
    const { title, subtitle } = headerForAsset(assetType, hasDedicatedSchematic);

    return (
        <HudFrame
            title={title}
            subtitle={subtitle}
            bannerNote={DEMO_MOCK ? 'synthetic 3D schematic' : undefined}
            contentClassName={transitClass(transitPhase)}
            contentOverlayActive={transitPhase === 'transit'}
        >
            <Canvas camera={{ position: [10, 10, 10], fov: 50 }}>
                <color attach="background" args={[0x020617]} />
                <fogExp2 attach="fog" args={[0x020617, 0.05]} />
                <ambientLight intensity={0.4} />
                <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />

                <OrbitControls enableDamping dampingFactor={0.05} />

                {assetType === 'LASER_SHORAD' && <LaserShorad degraded={degraded} />}
                {assetType === 'ARTILLERY' && <Artillery degraded={degraded} />}
                {assetType === 'QUADRUPED' && <Quadruped degraded={degraded} />}
                {!hasDedicatedSchematic && <VehicleClassSchematic degraded={degraded} />}
            </Canvas>
        </HudFrame>
    );
}
