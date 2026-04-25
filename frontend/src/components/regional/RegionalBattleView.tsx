import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const BATTERY_DATA = [
  { id: 'Bravo', x: -40, z: 20, color: 0x10b981 },
  { id: 'Foxtrot', x: 30, z: 40, color: 0x10b981 },
  { id: 'Uniform', x: -20, z: -50, color: 0x10b981 },
  { id: 'Echo', x: 60, z: -20, color: 0x10b981 }
];

function Terrain() {
  const geoRef = useRef<THREE.PlaneGeometry>(null);
  
  useMemo(() => {
    if (geoRef.current) {
      const pos = geoRef.current.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vz = pos.getZ(i);
        const y = Math.sin(vx * 0.05) * Math.cos(vz * 0.05) * 5;
        pos.setY(i, y - 5);
      }
      geoRef.current.computeVertexNormals();
    }
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry ref={geoRef} args={[400, 400, 30, 30]} />
      <meshStandardMaterial color={0x0f172a} roughness={1.0} flatShading />
    </mesh>
  );
}

function RadarBattery({ data, degradedBravo }: { data: any, degradedBravo: boolean }) {
  const shieldRef = useRef<THREE.Mesh>(null);
  const isBravo = data.id === 'Bravo';
  const isDegraded = isBravo && degradedBravo;
  const currentColor = isDegraded ? 0xf43f5e : data.color;

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
    <group position={[data.x, 0, data.z]}>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[6, 3, 8]} />
        <meshStandardMaterial color={0x334155} />
      </mesh>
      <mesh position={[0, 3.5, 2]} rotation={[-Math.PI / 6, 0, 0]}>
        <boxGeometry args={[6, 7, 1.5]} />
        <meshStandardMaterial color={0x1e293b} metalness={0.8} />
      </mesh>
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

function Threat({ target }: { target: THREE.Vector3 }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [speed] = React.useState(0.2 + Math.random() * 0.3);
  const [currentTarget, setCurrentTarget] = React.useState(target);

  React.useEffect(() => {
    if (meshRef.current) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 200 + Math.random() * 50;
      meshRef.current.position.set(Math.cos(angle) * dist, 40 + Math.random() * 20, Math.sin(angle) * dist);
    }
  }, []);

  useFrame(() => {
    if (meshRef.current) {
      const dir = new THREE.Vector3().subVectors(currentTarget, meshRef.current.position).normalize();
      meshRef.current.position.add(dir.multiplyScalar(speed));
      meshRef.current.lookAt(currentTarget);

      if (meshRef.current.position.distanceTo(currentTarget) < 10) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 200 + Math.random() * 50;
        meshRef.current.position.set(Math.cos(angle) * dist, 40 + Math.random() * 20, Math.sin(angle) * dist);
        const nextTargetData = BATTERY_DATA[Math.floor(Math.random() * BATTERY_DATA.length)];
        setCurrentTarget(new THREE.Vector3(nextTargetData.x, 0, nextTargetData.z));
      }
    }
  });

  return (
    <mesh ref={meshRef} rotation={[Math.PI / 2, 0, 0]}>
      <coneGeometry args={[2, 6, 4]} />
      <meshBasicMaterial color={0xf43f5e} wireframe />
    </mesh>
  );
}

export default function RegionalBattleView({ degradedBravo }: { degradedBravo: boolean }) {
  const initialTargets = useMemo(() => {
    return Array.from({ length: 4 }).map(() => {
      const b = BATTERY_DATA[Math.floor(Math.random() * BATTERY_DATA.length)];
      return new THREE.Vector3(b.x, 0, b.z);
    });
  }, []);

  return (
    <div className="col-span-2 panel flex flex-col relative overflow-hidden">
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start">
        <div>
          <h1 className="glitch-text text-2xl font-bold text-emerald-400">REGIONAL BATTLEVIEW</h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400">THEATER SUB-SECTOR: MEDITERRANEAN EAST</p>
        </div>
        <div className="text-right bg-slate-900/80 p-2 border border-slate-700">
          <div className="text-[10px] text-slate-500 mb-1">THEATER THREAT DETECTIONS</div>
          <div className="text-xl font-bold text-rose-400 flex items-center justify-end">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse mr-2"></span>
            4 ACTIVE
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 rounded-full bg-emerald-500/20 border border-emerald-500"></div>
          <span className="text-slate-300">NOMINAL COVERAGE</span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 rounded-full bg-amber-500/20 border border-amber-500"></div>
          <span className="text-slate-300">DEGRADED SECTOR</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border border-rose-500 bg-rose-500/20"></div>
          <span className="text-slate-300">INBOUND THREAT</span>
        </div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 150, 180], fov: 40 }}>
          <color attach="background" args={[0x020617]} />
          <fogExp2 attach="fog" args={[0x020617, 0.005]} />
          <ambientLight intensity={0.3} />
          <directionalLight position={[50, 100, 50]} intensity={0.8} />
          
          <OrbitControls enableDamping dampingFactor={0.05} maxDistance={300} minDistance={50} maxPolarAngle={Math.PI / 2 - 0.1} />
          
          <gridHelper args={[400, 100, 0x1e293b, 0x0f172a]} position={[0, -2, 0]} />
          <Terrain />

          {BATTERY_DATA.map(data => (
            <RadarBattery key={data.id} data={data} degradedBravo={degradedBravo} />
          ))}

          {initialTargets.map((target, i) => (
            <Threat key={i} target={target} />
          ))}
        </Canvas>
      </div>

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN REGION • [RMB] ROTATE VIEW • [SCROLL] MAGNIFY
      </div>
    </div>
  );
}