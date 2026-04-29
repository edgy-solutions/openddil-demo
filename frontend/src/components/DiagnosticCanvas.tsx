import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import LtamdsView from './LtamdsView';

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
                                rotation={[0, -angle + Math.PI/2, 0]}
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
                            <mesh rotation={[Math.PI/2, 0, 0]}>
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
                <group position={[2.26, 2, 0]} rotation={[0, Math.PI/2, 0]}>
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
            <group position={[0, 3.5, 0]} rotation={[0, 0, Math.PI/2]}>
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
                    <group key={`grid-${i}-${j}`} position={[x, 4.65, z]} rotation={[-Math.PI/2, 0, 0]}>
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
                        <mesh ref={anomalyCoreRef} rotation={[Math.PI/2, 0, 0]}>
                            <cylinderGeometry args={[0.4, 0.4, 0.6, 32]} />
                            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.8} blending={THREE.AdditiveBlending} />
                        </mesh>
                    ) : (
                        <mesh rotation={[Math.PI/2, 0, 0]}>
                            <cylinderGeometry args={[0.35, 0.35, 0.5, 32]} />
                            <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                        </mesh>
                    )}
                    
                    {/* Thigh */}
                    <group rotation={[0, 0, -Math.PI/6]}>
                        <mesh position={[0, -0.8, 0]}>
                            <cylinderGeometry args={[0.2, 0.15, 1.6, 16]} />
                            <meshStandardMaterial color={0x0f172a} metalness={0.8} roughness={0.2} />
                        </mesh>
                        <mesh position={[0, -0.8, 0]}>
                            <cylinderGeometry args={[0.21, 0.16, 1.6, 8]} />
                            <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
                        </mesh>
                        
                        {/* Knee Motor */}
                        <mesh position={[0, -1.6, 0]} rotation={[Math.PI/2, 0, 0]}>
                            <cylinderGeometry args={[0.25, 0.25, 0.4, 32]} />
                            <meshStandardMaterial color={0x1e293b} metalness={0.9} roughness={0.1} />
                        </mesh>

                        {/* Shin */}
                        <group position={[0, -1.6, 0]} rotation={[0, 0, Math.PI/6]}>
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

export default function DiagnosticCanvas({ assetType, degraded, coreTemp }: { assetType: string, degraded: boolean, coreTemp: number }) {
    if (assetType === 'RADAR') {
        return <LtamdsView degraded={degraded} coreTemp={coreTemp} />;
    }

    return (
        <div className="absolute inset-0 bg-[#020617] text-[#22d3ee] font-mono select-none overflow-hidden">
            <style>{`
                .hud-border {
                    border: 1px solid rgba(34, 211, 238, 0.3);
                    background: rgba(15, 23, 42, 0.85);
                    backdrop-filter: blur(12px);
                    clip-path: polygon(0% 0%, 90% 0%, 100% 10%, 100% 100%, 10% 100%, 0% 90%);
                    box-shadow: 0 0 30px rgba(34, 211, 238, 0.1);
                }
                .glitch-text {
                    text-transform: uppercase;
                    letter-spacing: 0.2em;
                    text-shadow: 0 0 10px #22d3ee;
                }
            `}</style>
            
            <Canvas camera={{ position: [10, 10, 10], fov: 50 }}>
                <color attach="background" args={[0x020617]} />
                <fogExp2 attach="fog" args={[0x020617, 0.05]} />
                <ambientLight intensity={0.4} />
                <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />
                
                <OrbitControls enableDamping dampingFactor={0.05} />
                
                {assetType === 'LASER_SHORAD' && <LaserShorad degraded={degraded} />}
                {assetType === 'ARTILLERY' && <Artillery degraded={degraded} />}
                {assetType === 'QUADRUPED' && <Quadruped degraded={degraded} />}
            </Canvas>

            {/* Top Left Overlay */}
            <div className="absolute top-6 left-6 z-10 pointer-events-none">
                <h1 className="glitch-text text-2xl font-bold text-cyan-400">{assetType} DIAGNOSTICS</h1>
                <p className="text-xs tracking-widest opacity-70">ENGINEERING SCHEMATIC @[//] LIVE</p>
            </div>
        </div>
    );
}
