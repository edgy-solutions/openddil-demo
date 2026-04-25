import React, { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const REGIONS = [
  { id: 'West', x: -300, z: 100, count: 4, color: 0x10b981 },
  { id: 'Central', x: 100, z: -50, count: 6, color: 0x10b981 },
  { id: 'East', x: 450, z: 200, count: 3, color: 0x10b981 },
  { id: 'South', x: 200, z: 350, count: 4, color: 0x10b981 }
];

function AbstractContinents() {
  const geoRef = useRef<THREE.PlaneGeometry>(null);

  useMemo(() => {
    if (geoRef.current) {
      const pos = geoRef.current.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vz = pos.getZ(i);
        let y = Math.sin(vx * 0.005) * Math.cos(vz * 0.005) * 40;
        y += Math.sin(vx * 0.02) * Math.cos(vz * 0.02) * 15;
        if (y < 5) y = -10;
        pos.setY(i, y - 5);
      }
      geoRef.current.computeVertexNormals();
    }
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry ref={geoRef} args={[2000, 2000, 60, 60]} />
      <meshBasicMaterial color={0x334155} wireframe transparent opacity={0.15} />
    </mesh>
  );
}

function MacroRadar({ x, z, color, wanActive }: { x: number, z: number, color: number, wanActive: boolean }) {
  const shieldRef = useRef<THREE.Mesh>(null);
  const domeRadius = useMemo(() => 90 + Math.random() * 30, []);

  useFrame((state) => {
    if (!wanActive) return; // Freeze time
    const time = state.clock.getElapsedTime();
    if (shieldRef.current) {
      (shieldRef.current.material as THREE.MeshBasicMaterial).opacity = 0.05 + Math.sin(time * 0.5 + x) * 0.05;
    }
  });

  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 2, 0]}>
        <octahedronGeometry args={[4, 0]} />
        <meshBasicMaterial color={0xffffff} />
      </mesh>
      <mesh ref={shieldRef}>
        <sphereGeometry args={[domeRadius, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={color} transparent opacity={0.1} wireframe blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[domeRadius - 1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={color} transparent opacity={0.05} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Threat({ targets, wanActive }: { targets: THREE.Vector3[], wanActive: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [speed] = React.useState(0.5 + Math.random() * 1.5);
  const [currentTarget, setCurrentTarget] = React.useState<THREE.Vector3 | null>(null);

  useEffect(() => {
    if (targets.length > 0 && !currentTarget) {
      setCurrentTarget(targets[Math.floor(Math.random() * targets.length)]);
    }
  }, [targets, currentTarget]);

  useEffect(() => {
    if (meshRef.current) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 800 + Math.random() * 400;
      meshRef.current.position.set(Math.cos(angle) * dist, 100 + Math.random() * 100, Math.sin(angle) * dist);
    }
  }, []);

  useFrame(() => {
    if (!wanActive) return; // Freeze time
    if (meshRef.current && currentTarget) {
      const dir = new THREE.Vector3().subVectors(currentTarget, meshRef.current.position).normalize();
      meshRef.current.position.add(dir.multiplyScalar(speed));
      meshRef.current.lookAt(currentTarget);

      if (meshRef.current.position.distanceTo(currentTarget) < 50) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 800 + Math.random() * 400;
        meshRef.current.position.set(Math.cos(angle) * dist, 100 + Math.random() * 100, Math.sin(angle) * dist);
        setCurrentTarget(targets[Math.floor(Math.random() * targets.length)]);
      }
    }
  });

  return (
    <mesh ref={meshRef} rotation={[Math.PI / 2, 0, 0]}>
      <coneGeometry args={[4, 12, 4]} />
      <meshBasicMaterial color={0xf43f5e} wireframe />
    </mesh>
  );
}

export default function HqBattleView({ wanActive, threatCount }: { wanActive: boolean, threatCount: number }) {
  const radars = useMemo(() => {
    const list: { x: number, z: number, color: number }[] = [];
    REGIONS.forEach(region => {
      for (let i = 0; i < region.count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 120;
        list.push({
          x: region.x + Math.cos(angle) * dist,
          z: region.z + Math.sin(angle) * dist,
          color: region.color
        });
      }
    });
    return list;
  }, []);

  const targets = useMemo(() => radars.map(r => new THREE.Vector3(r.x, 0, r.z)), [radars]);

  return (
    <div className={`col-span-2 panel flex flex-col relative overflow-hidden transition-all duration-500 ${!wanActive ? 'border-rose-900 shadow-[inset_0_0_30px_rgba(225,29,72,0.2)]' : ''}`} id="panel-battleview">
      
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start">
        <div>
          <h1 className={`glitch-text text-3xl font-bold transition-colors ${wanActive ? 'text-emerald-400 shadow-[0_0_10px_#10b981]' : 'text-rose-500 shadow-[0_0_10px_#f43f5e]'}`} style={{ textShadow: wanActive ? '0 0 10px #10b981' : '0 0 10px #f43f5e' }}>
            THEATER COMMAND VIEW
          </h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400 mt-1">GLOBAL CONTIGUOUS SHIELD NETWORK @[//] ALL REGIONS</p>
        </div>
        <div className="text-right bg-slate-900/80 p-2 border border-slate-700">
          <div className="text-[10px] text-slate-500 mb-1">GLOBAL THREAT DETECTIONS</div>
          <div className="text-3xl font-bold text-rose-400 flex items-center justify-end font-rajdhani">
            <span className={`w-3 h-3 rounded-full bg-rose-500 mr-3 ${wanActive ? 'animate-pulse' : ''}`}></span>
            <span>{threatCount}</span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2"><div className="w-3 h-3 rounded-full bg-emerald-500/20 border border-emerald-500"></div><span className="text-slate-300">ACTIVE SHIELD</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 border border-rose-500 bg-rose-500/20"></div><span className="text-slate-300">TRACKED TARGET</span></div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 500, 600], fov: 45 }}>
          <color attach="background" args={[0x020617]} />
          <fogExp2 attach="fog" args={[0x020617, 0.0015]} />
          <ambientLight intensity={0.4} />
          <directionalLight position={[200, 500, 200]} intensity={0.6} color={0x22d3ee} />
          
          <OrbitControls enableDamping dampingFactor={0.05} maxDistance={1200} minDistance={200} maxPolarAngle={Math.PI / 2 - 0.1} />
          
          <gridHelper args={[2000, 100, 0x1e293b, 0x0f172a]} position={[0, -2, 0]} />
          <AbstractContinents />

          {radars.map((r, i) => (
            <MacroRadar key={i} x={r.x} z={r.z} color={r.color} wanActive={wanActive} />
          ))}

          {Array.from({ length: 40 }).map((_, i) => (
            <Threat key={i} targets={targets} wanActive={wanActive} />
          ))}
        </Canvas>
      </div>

      {!wanActive && <div className="absolute inset-0 bg-rose-950/30 z-20 pointer-events-none"></div>}

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN CONTINENT • [RMB] ROTATE • [SCROLL] ZOOM
      </div>
    </div>
  );
}