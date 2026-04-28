import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import LtamdsView from './LtamdsView';

function LaserShorad({ degraded }: { degraded: boolean }) {
    const coreRef = useRef<THREE.Mesh>(null);
    
    useFrame((state) => {
        if (coreRef.current && degraded) {
            const time = state.clock.getElapsedTime();
            (coreRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xef4444); // Red
            (coreRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 10) * 0.5;
        } else if (coreRef.current) {
            (coreRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x22d3ee); // Cyan
            (coreRef.current.material as THREE.MeshBasicMaterial).opacity = 0.8;
        }
    });

    return (
        <group>
            {/* Inner Core */}
            <mesh ref={coreRef} position={[0, 0, 0]}>
                <cylinderGeometry args={[1, 1, 8, 32]} />
                <meshBasicMaterial color={0x22d3ee} transparent opacity={0.8} blending={THREE.AdditiveBlending} />
            </mesh>
            {/* Outer Cooling Jacket */}
            <mesh position={[0, 0, 0]}>
                <cylinderGeometry args={[1.5, 1.5, 8, 16]} />
                <meshBasicMaterial color={0x334155} wireframe transparent opacity={0.5} />
            </mesh>
        </group>
    );
}

function Artillery({ degraded }: { degraded: boolean }) {
    const hingeRef = useRef<THREE.Mesh>(null);
    const podRef = useRef<THREE.Group>(null);
    
    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (podRef.current) {
            if (!degraded) {
                podRef.current.rotation.x = Math.sin(time * 0.5) * 0.2 + 0.5;
            }
        }
        if (hingeRef.current && degraded) {
            (hingeRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xf59e0b); // Amber
            (hingeRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 8) * 0.5;
        } else if (hingeRef.current) {
            (hingeRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x334155);
            (hingeRef.current.material as THREE.MeshBasicMaterial).opacity = 1.0;
        }
    });

    return (
        <group>
            <mesh ref={hingeRef} position={[0, -2, 0]}>
                <boxGeometry args={[4, 1, 4]} />
                <meshBasicMaterial color={0x334155} wireframe />
            </mesh>
            <group ref={podRef} position={[0, -1.5, 0]}>
                {[0, 1, 2, 3, 4, 5].map((i) => {
                    const angle = (i / 6) * Math.PI * 2;
                    return (
                        <mesh key={i} position={[Math.cos(angle) * 1.5, 2, Math.sin(angle) * 1.5]}>
                            <cylinderGeometry args={[0.6, 0.6, 6, 8]} />
                            <meshBasicMaterial color={0x22d3ee} wireframe />
                        </mesh>
                    );
                })}
            </group>
        </group>
    );
}

function Quadruped({ degraded }: { degraded: boolean }) {
    const jointRef = useRef<THREE.Mesh>(null);
    
    useFrame((state) => {
        if (jointRef.current && degraded) {
            const time = state.clock.getElapsedTime();
            (jointRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xef4444);
            (jointRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(time * 10) * 0.5;
        } else if (jointRef.current) {
            (jointRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x22d3ee);
            (jointRef.current.material as THREE.MeshBasicMaterial).opacity = 0.8;
        }
    });

    return (
        <group>
            {/* Body */}
            <mesh position={[0, 2, 0]}>
                <boxGeometry args={[2, 1, 4]} />
                <meshBasicMaterial color={0x334155} wireframe />
            </mesh>
            {/* Joints and Legs */}
            {[[-1.2, 2, 2], [1.2, 2, 2], [1.2, 2, -2]].map((pos, i) => (
                <group key={i} position={pos as [number, number, number]}>
                    <mesh>
                        <sphereGeometry args={[0.3, 8, 8]} />
                        <meshBasicMaterial color={0x22d3ee} wireframe />
                    </mesh>
                    <mesh position={[0, -1, 0]}>
                        <cylinderGeometry args={[0.1, 0.1, 2]} />
                        <meshBasicMaterial color={0x22d3ee} wireframe />
                    </mesh>
                </group>
            ))}
            {/* Rear-left joint (anomaly point) */}
            <group position={[-1.2, 2, -2]}>
                <mesh ref={jointRef}>
                    <sphereGeometry args={[0.4, 16, 16]} />
                    <meshBasicMaterial color={0x22d3ee} transparent opacity={0.8} blending={THREE.AdditiveBlending} />
                </mesh>
                <mesh position={[0, -1, 0]}>
                    <cylinderGeometry args={[0.1, 0.1, 2]} />
                    <meshBasicMaterial color={0x22d3ee} wireframe />
                </mesh>
            </group>
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
