import React, { useRef, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import DdilNetworkLink from '../DdilNetworkLink';
import LogisticsHubNode from '../LogisticsHubNode';
import TacticalMapUnderlay from '../TacticalMapUnderlay';

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
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -5, 0]}>
      <planeGeometry ref={geoRef} args={[2000, 2000, 60, 60]} />
      <meshStandardMaterial 
        color={0x020617} 
        metalness={0.6} 
        roughness={0.4} 
        flatShading={true} 
      />
    </mesh>
  );
}

export default function HqBattleView({ wanActive, linksUp, linksDown }: { wanActive: boolean, linksUp: number, linksDown: number }) {
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
          <div className="text-[10px] text-slate-500 mb-1">GLOBAL LINK STATUS</div>
          <div className="text-xl font-bold flex items-center justify-end font-rajdhani">
            <span className="text-emerald-400 mr-4">{linksUp} UP</span>
            <span className="text-rose-400">{linksDown} DOWN</span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2"><div className="w-3 h-3 bg-emerald-500"></div><span className="text-slate-300">NOMINAL LINK</span></div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-rose-500"></div><span className="text-slate-300">SEVERED LINK</span></div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 150, 600], fov: 45 }}>
          <color attach="background" args={[0x020617]} />
          <fog attach="fog" args={[0x020617, 200, 1500]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[200, 500, 200]} intensity={1.5} color={0x22d3ee} />
          <hemisphereLight groundColor={0x020617} intensity={0.5} />
          
          <OrbitControls enableDamping dampingFactor={0.05} maxDistance={1200} minDistance={200} maxPolarAngle={Math.PI / 2 - 0.1} target={[0, 0, -100]} />
          
          <Grid 
            position={[0, -2, 0]} 
            args={[2000, 2000]} 
            cellSize={20} 
            cellThickness={0.5} 
            sectionSize={100} 
            sectionThickness={1.5} 
            cellColor="#22d3ee" 
            sectionColor="#10b981" 
            fadeDistance={1500} 
          />
          
          {/* Concentric Rings */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[200, 202, 64]} />
            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[400, 404, 64]} />
            <meshBasicMaterial color={0x10b981} transparent opacity={0.1} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 0]}>
            <ringGeometry args={[600, 606, 64]} />
            <meshBasicMaterial color={0x22d3ee} transparent opacity={0.05} side={THREE.DoubleSide} />
          </mesh>

          <AbstractContinents />

          {radars.map((r, i) => (
            <LogisticsHubNode key={`node-${i}`} position={[r.x, 0, r.z]} />
          ))}

          {radars.map((r, i) => (
            <DdilNetworkLink 
              key={`link-${i}`}
              start={new THREE.Vector3(0, 0, 0)}
              end={new THREE.Vector3(r.x, 0, r.z)}
              status={wanActive ? 'NOMINAL' : 'SEVERED'}
            />
          ))}

          <React.Suspense fallback={null}>
            <TacticalMapUnderlay />
          </React.Suspense>

          <EffectComposer>
            <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} luminanceSmoothing={0.9} />
          </EffectComposer>
        </Canvas>
      </div>

      {!wanActive && <div className="absolute inset-0 bg-rose-950/30 z-20 pointer-events-none"></div>}

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN CONTINENT • [RMB] ROTATE • [SCROLL] ZOOM
      </div>
    </div>
  );
}