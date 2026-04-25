import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

function BattleScene({ degraded, radarColor }: { degraded: boolean, radarColor: string }) {
  const threatRef = useRef<THREE.Mesh>(null);
  const shieldRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const time = state.clock.getElapsedTime();
    if (threatRef.current) {
      const radius = 35 + Math.sin(time * 0.5) * 5;
      threatRef.current.position.set(
        Math.cos(time * 0.8) * radius, 
        10 + Math.sin(time * 2) * 2, 
        Math.sin(time * 0.8) * radius
      );
      threatRef.current.lookAt(0, 0, 0);
    }
    if (shieldRef.current) {
      const pulseSpeed = degraded ? 4 : 2;
      (shieldRef.current.material as THREE.MeshBasicMaterial).opacity = (degraded ? 0.05 : 0.15) + Math.sin(time * pulseSpeed) * 0.05;
      (shieldRef.current.material as THREE.MeshBasicMaterial).wireframeLinewidth = degraded ? 1 : 2;
    }
  });

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[20, 50, 20]} intensity={0.8} />
      <gridHelper args={[100, 40, 0x334155, 0x1e293b]} position={[0, -2, 0]} />

      <group>
        <mesh position={[0, -1, 0]}>
          <boxGeometry args={[4, 2, 6]} />
          <meshStandardMaterial color={0x334155} roughness={0.8} />
        </mesh>
        <mesh position={[0, 1.5, 1.5]} rotation={[-Math.PI / 8, 0, 0]}>
          <boxGeometry args={[4.5, 5, 1]} />
          <meshStandardMaterial color={0x1e293b} roughness={0.5} metalness={0.8} />
        </mesh>
      </group>

      <mesh ref={shieldRef} position={[0, -2, 0]}>
        <sphereGeometry args={[25, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={radarColor} transparent opacity={0.15} wireframe blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh position={[0, -2, 0]}>
        <sphereGeometry args={[24.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={radarColor} transparent opacity={0.05} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh ref={threatRef} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[1.5, 4, 4]} />
        <meshBasicMaterial color={0xf43f5e} wireframe />
      </mesh>
    </>
  );
}

export default function BattleView({ degraded, radarColor }: { degraded: boolean, radarColor: string }) {
  return (
    <div className="absolute bottom-4 left-4 w-[280px] h-[180px] border border-slate-700 bg-slate-900/90 shadow-2xl z-20 flex flex-col pointer-events-none panel">
      <div className="bg-slate-800 text-[10px] px-2 py-1 text-slate-300 font-bold font-mono border-b border-slate-700 flex justify-between items-center">
        <span className="tracking-wider">TACTICAL BATTLEVIEW</span>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-rose-500 rounded-full animate-pulse"></span>
          <span className="text-rose-400 text-[8px]">LIVE</span>
        </div>
      </div>
      <div className="flex-1 w-full relative overflow-hidden">
        <Canvas camera={{ position: [60, 45, 60], fov: 35 }}>
          <BattleScene degraded={degraded} radarColor={radarColor} />
        </Canvas>
      </div>
    </div>
  );
}