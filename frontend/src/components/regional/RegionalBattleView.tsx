import { useRef, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import AssetSpawner from '../AssetSpawner';
import DdilNetworkLink from '../DdilNetworkLink';
import LogisticsArc from '../LogisticsArc';

const DISCOVERED_FLEET: { id: string, type: string, position: [number, number, number], status: 'NOMINAL' | 'DEGRADED' | 'CRITICAL' | 'COMM_LOST' }[] = [
  { id: 'LTAMDS-04', type: 'RADAR', position: [-40, 0, 20], status: 'NOMINAL' },
  { id: 'STRYKER-DE-09', type: 'LASER_SHORAD', position: [30, 0, 40], status: 'DEGRADED' },
  { id: 'HIMARS-ALPHA', type: 'ARTILLERY', position: [10, 0, -20], status: 'NOMINAL' },
  { id: 'GHOST-UGV-1', type: 'QUADRUPED', position: [-80, 0, 70], status: 'COMM_LOST' }
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

function CameraRig({ targetPos, isZoomed }: { targetPos: THREE.Vector3 | null, isZoomed: boolean }) {
  const { camera, controls } = useThree();
  useFrame(() => {
    if (isZoomed && targetPos) {
      camera.position.lerp(new THREE.Vector3(targetPos.x + 15, targetPos.y + 10, targetPos.z + 15), 0.05);
      if (controls) {
        (controls as any).target.lerp(new THREE.Vector3(targetPos.x, targetPos.y + 4, targetPos.z), 0.05);
      }
    } else {
      camera.position.lerp(new THREE.Vector3(0, 150, 180), 0.05);
      if (controls) {
        (controls as any).target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
      }
    }
  });
  return null;
}

function FogController({ isZoomed }: { isZoomed: boolean }) {
  const { scene } = useThree();
  useFrame(() => {
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, isZoomed ? 0.08 : 0.005, 0.05);
    }
  });
  return null;
}

export default function RegionalBattleView({ link1, selectedAssetId, onAssetSelect }: { link1: boolean, selectedAssetId: string | null, onAssetSelect: (id: string | null, type: string | null) => void }) {
  const targetAsset = useMemo(() => DISCOVERED_FLEET.find(a => a.id === selectedAssetId), [selectedAssetId]);
  const targetPos = targetAsset ? new THREE.Vector3(...targetAsset.position) : null;

  return (
    <div className="col-span-2 panel flex flex-col relative overflow-hidden">
      <div className="absolute top-4 left-4 z-10 pointer-events-none w-full pr-8 flex justify-between items-start">
        <div>
          <h1 className="glitch-text text-2xl font-bold text-emerald-400">REGIONAL BATTLEVIEW</h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400">THEATER SUB-SECTOR: MEDITERRANEAN EAST</p>
        </div>
        <div className="text-right bg-slate-900/80 p-2 border border-slate-700">
          <div className="text-[10px] text-slate-500 mb-1">THEATER LINK STATUS</div>
          <div className="text-xl font-bold flex items-center justify-end font-rajdhani">
            <span className="text-emerald-400 mr-4">{link1 ? 4 : 0} UP</span>
            <span className="text-rose-400">{link1 ? 0 : 4} DOWN</span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 bg-slate-900/80 border border-slate-700 p-3 text-[10px] font-mono">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 bg-emerald-500"></div>
          <span className="text-slate-300">NOMINAL LINK</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-rose-500"></div>
          <span className="text-slate-300">SEVERED LINK</span>
        </div>
      </div>

      <div className="absolute inset-0 cursor-move">
        <Canvas camera={{ position: [0, 150, 180], fov: 40 }} onPointerMissed={() => onAssetSelect(null, null)}>
          <color attach="background" args={[0x020617]} />
          <fogExp2 attach="fog" args={[0x020617, 0.005]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[50, 100, 50]} intensity={1.5} />
          <hemisphereLight groundColor={0x020617} intensity={0.5} />
          
          <OrbitControls makeDefault enableDamping dampingFactor={0.05} maxDistance={300} minDistance={10} maxPolarAngle={Math.PI / 2 - 0.1} />
          
          <CameraRig targetPos={targetPos} isZoomed={!!selectedAssetId} />
          <FogController isZoomed={!!selectedAssetId} />

          <gridHelper args={[400, 100, 0x1e293b, 0x0f172a]} position={[0, -2, 0]} />
          <Terrain />

          <AssetSpawner assets={DISCOVERED_FLEET} onAssetClick={onAssetSelect} selectedAssetId={selectedAssetId} />

          {DISCOVERED_FLEET.map((asset, i) => (
            <DdilNetworkLink 
              key={`link-${i}`} 
              start={new THREE.Vector3(0, 0, -80)} 
              end={new THREE.Vector3(...asset.position)} 
              status={link1 ? 'NOMINAL' : 'SEVERED'} 
            />
          ))}

          <LogisticsArc 
            start={new THREE.Vector3(50, 0, -50)} 
            end={new THREE.Vector3(...DISCOVERED_FLEET[1].position)} 
            item="Rear Actuator" 
          />
        </Canvas>
      </div>

      <div className="absolute bottom-4 left-4 z-10 text-[10px] font-mono text-slate-500 uppercase tracking-tighter pointer-events-none">
        [LMB] PAN REGION • [RMB] ROTATE VIEW • [SCROLL] MAGNIFY
      </div>
    </div>
  );
}