import { Suspense, useMemo, useRef, Component } from 'react';
import type { ReactNode } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { LaserShorad, Artillery, Quadruped, RadarXRay } from './DiagnosticCanvas';
import AssetCallout from './AssetCallout';

class ErrorBoundary extends Component<{ fallback: ReactNode, children: ReactNode }, { hasError: boolean }> {
    constructor(props: { fallback: ReactNode, children: ReactNode }) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

function RadarShield({ isDegraded }: { isDegraded: boolean }) {
    const shieldRef = useRef<THREE.Mesh>(null);
    const currentColor = isDegraded ? 0xf43f5e : 0x10b981;

    useFrame((state) => {
        const time = state.clock.getElapsedTime();
        if (shieldRef.current) {
            const pulseSpeed = isDegraded ? 4 : 1.5;
            const baseOpacity = isDegraded ? 0.05 : 0.15;
            (shieldRef.current.material as THREE.MeshBasicMaterial).opacity = baseOpacity + Math.sin(time * pulseSpeed) * 0.05;
            (shieldRef.current.material as THREE.MeshBasicMaterial).wireframeLinewidth = isDegraded ? 1 : 2;
        }
    });

    return (
        <group>
            <mesh ref={shieldRef} position={[0, -1, 0]}>
                <sphereGeometry args={[45, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshBasicMaterial color={currentColor} transparent opacity={0.15} wireframe blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
            <mesh position={[0, -1, 0]}>
                <sphereGeometry args={[44.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshBasicMaterial color={currentColor} transparent opacity={0.08} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
                <ringGeometry args={[45, 46, 64]} />
                <meshBasicMaterial color={currentColor} transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>
        </group>
    );
}

function RadarFallback() {
    return (
        <group scale={2.5}>
            <mesh position={[0, 0, 0]}>
                <boxGeometry args={[6, 3, 8]} />
                <meshStandardMaterial color={0x334155} />
            </mesh>
            <mesh position={[0, 3.5, 2]} rotation={[-Math.PI / 6, 0, 0]}>
                <boxGeometry args={[6, 7, 1.5]} />
                <meshStandardMaterial color={0x1e293b} metalness={0.8} />
            </mesh>
        </group>
    );
}

function LaserFallback() {
    return (
        <group position={[0, 1, 0]} scale={2.5}>
            <mesh>
                <boxGeometry args={[2, 2, 3]} />
                <meshStandardMaterial color={0x22d3ee} emissive={0x22d3ee} emissiveIntensity={0.5} transparent opacity={0.8} />
            </mesh>
            <mesh position={[0, 2, 0]}>
                <cylinderGeometry args={[0.1, 0.1, 4]} />
                <meshStandardMaterial color={0x22d3ee} emissive={0x22d3ee} emissiveIntensity={1} />
            </mesh>
        </group>
    );
}

function ArtilleryFallback() {
    return (
        <mesh position={[0, 1, 0]} rotation={[0.2, 0, 0]} scale={15}>
            <boxGeometry args={[2, 1.5, 4]} />
            <meshStandardMaterial color={0x22d3ee} emissive={0x22d3ee} emissiveIntensity={0.5} transparent opacity={0.8} />
        </mesh>
    );
}

function QuadrupedFallback() {
    return (
        <mesh position={[0, 0.5, 0]} scale={7.5}>
            <tetrahedronGeometry args={[1]} />
            <meshStandardMaterial color={0x22d3ee} emissive={0x22d3ee} emissiveIntensity={0.5} transparent opacity={0.8} />
        </mesh>
    );
}

function AssetModel({ url, scale = 2.5, yOffset = 0 }: { url: string, scale?: number, yOffset?: number }) {
    const { scene } = useGLTF(url);
    const clonedScene = useMemo(() => scene.clone(), [scene]);
    return <primitive object={clonedScene} scale={scale} position={[0, yOffset, 0]} />;
}

export default function AssetSpawner({ assets, onAssetClick, selectedAssetId }: { assets: { id: string, type: string, position: [number, number, number], status?: 'NOMINAL' | 'DEGRADED' | 'CRITICAL' | 'COMM_LOST' }[], onAssetClick?: (id: string, type: string) => void, selectedAssetId?: string | null }) {
    return (
        <group>
            {assets.map(asset => {
                let Fallback = RadarFallback;
                let url = '/models/ltamds.glb';
                let scale = 2.5;
                let yOffset = 0;
                
                if (asset.type === 'LASER_SHORAD') {
                    Fallback = LaserFallback;
                    url = '/models/stryker.glb';
                    scale = 2.5;
                    yOffset = 0;
                } else if (asset.type === 'ARTILLERY') {
                    Fallback = ArtilleryFallback;
                    url = '/models/himars.glb';
                    scale = 15;
                    yOffset = 6;
                } else if (asset.type === 'QUADRUPED') {
                    Fallback = QuadrupedFallback;
                    url = '/models/ugv.glb';
                    scale = 7.5;
                    yOffset = 2;
                }
                
                return (
                    <group 
                        key={asset.id} 
                        position={asset.position} 
                        onClick={(e) => {
                            e.stopPropagation();
                            onAssetClick?.(asset.id, asset.type);
                        }}
                        onPointerOver={(e) => {
                            e.stopPropagation();
                            document.body.style.cursor = 'pointer';
                        }}
                        onPointerOut={(e) => {
                            e.stopPropagation();
                            document.body.style.cursor = 'auto';
                        }}
                    >
                        {asset.type === 'RADAR' && !selectedAssetId && <RadarShield isDegraded={asset.id === 'LTAMDS-04' && false} />}
                        
                        {selectedAssetId === asset.id ? (
                            <group position={[0, asset.type === 'RADAR' ? 0 : asset.type === 'LASER_SHORAD' ? 4 : asset.type === 'ARTILLERY' ? 6 : 0.5, 0]}>
                                {asset.type === 'RADAR' ? (
                                    <RadarXRay degraded={false} />
                                ) : asset.type === 'LASER_SHORAD' ? (
                                    <LaserShorad degraded={false} />
                                ) : asset.type === 'ARTILLERY' ? (
                                    <Artillery degraded={false} />
                                ) : asset.type === 'QUADRUPED' ? (
                                    <Quadruped degraded={false} />
                                ) : null}
                            </group>
                        ) : (
                            <ErrorBoundary fallback={<Fallback />}>
                                <Suspense fallback={<Fallback />}>
                                    <AssetModel url={url} scale={scale} yOffset={yOffset} />
                                </Suspense>
                            </ErrorBoundary>
                        )}
                        {!selectedAssetId && asset.status && (
                            <AssetCallout asset_id={asset.id} status={asset.status} heightOffset={asset.type === 'ARTILLERY' ? 12 : asset.type === 'QUADRUPED' ? 6 : 5} />
                        )}
                    </group>
                );
            })}
        </group>
    );
}
