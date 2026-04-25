import React, { useState, useMemo, useRef } from 'react';
import { Canvas, useFrame, ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const COLORS = { nominal: 0x22d3ee, warning: 0xfacc15, critical: 0xef4444, bg: 0x0f172a, housing: 0x1e293b };

interface ElementData {
  id: string;
  face: string;
  temp: string;
  health: string;
  healthValue: number;
  initialColor: number;
  initialHealth: string;
  initialHealthValue: number;
  pos: [number, number, number];
}

function LtamdsFace({ cols, rows, pos, rot, faceName, degraded, onSelect }: { cols: number, rows: number, pos: [number, number, number], rot: [number, number, number], faceName: string, degraded: boolean, onSelect: (data: ElementData) => void }) {
  const spacing = 0.65;
  const size = 0.5;

  const elements = useMemo(() => {
    const els: ElementData[] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const health = Math.random();
        let color = COLORS.nominal;
        let status = "NOMINAL";
        if (health > 0.98) { color = COLORS.critical; status = "CRITICAL FAILURE"; }
        else if (health > 0.94) { color = COLORS.warning; status = "DEGRADED"; }

        els.push({
          id: `TR-${Math.floor(Math.random() * 8999) + 1000}`,
          face: faceName,
          temp: (25 + Math.random() * 50).toFixed(1),
          health: status,
          healthValue: health,
          initialColor: color,
          initialHealth: status,
          initialHealthValue: health,
          pos: [(i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0]
        });
      }
    }
    return els;
  }, [cols, rows, faceName]);

  return (
    <group position={pos} rotation={rot}>
      {elements.map((el, idx) => {
        let isDegradedEl = false;
        if (degraded && Math.random() > 0.85) {
            isDegradedEl = true;
        }
        
        const currentColor = isDegradedEl ? COLORS.critical : el.initialColor;
        const currentEmissive = isDegradedEl ? COLORS.critical : el.initialColor;
        const currentIntensity = (isDegradedEl || el.healthValue > 0.94) ? 0.8 : 0.15;

        return (
          <LtamdsElement 
            key={idx} 
            data={el} 
            size={size} 
            color={currentColor} 
            emissive={currentEmissive} 
            intensity={currentIntensity}
            onClick={(e) => { e.stopPropagation(); onSelect(el); }}
          />
        );
      })}
    </group>
  );
}

function LtamdsElement({ data, size, color, emissive, intensity, onClick }: any) {
  const meshRef = useRef<THREE.Mesh>(null);
  
  useFrame((state) => {
      if (meshRef.current && data.health !== "NOMINAL") {
          const time = state.clock.getElapsedTime();
          (meshRef.current.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.4 + Math.sin(time * 2) * 0.4;
      }
  });

  return (
    <mesh ref={meshRef} position={data.pos} onClick={onClick}>
      <boxGeometry args={[size, size, 0.15]} />
      <meshPhongMaterial color={color} emissive={emissive} emissiveIntensity={intensity} />
    </mesh>
  );
}


export default function LtamdsView({ degraded, coreTemp }: { degraded: boolean, coreTemp: number }) {
  const [selectedElement, setSelectedElement] = useState<ElementData | null>(null);

  return (
    <div className="absolute inset-0">
      <Canvas camera={{ position: [15, 12, 20], fov: 50 }}>
        <color attach="background" args={[COLORS.bg]} />
        <fogExp2 attach="fog" args={[COLORS.bg, 0.03]} />
        <ambientLight intensity={0.4} />
        <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />
        <OrbitControls enableDamping dampingFactor={0.05} maxDistance={50} minDistance={2} />

        <mesh>
          <boxGeometry args={[7, 12, 5]} />
          <meshPhongMaterial color={COLORS.housing} transparent opacity={0.9} shininess={80} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(7, 12, 5)]} />
          <lineBasicMaterial color={0x334155} transparent opacity={0.5} />
        </lineSegments>

        <LtamdsFace cols={8} rows={14} pos={[0, 0, 2.51]} rot={[0, 0, 0]} faceName="PRIMARY NORTH" degraded={degraded} onSelect={setSelectedElement} />
        <LtamdsFace cols={5} rows={8} pos={[-3.51, 0, -1]} rot={[0, -Math.PI / 2, 0]} faceName="SECTOR ALPHA" degraded={degraded} onSelect={setSelectedElement} />
        <LtamdsFace cols={5} rows={8} pos={[3.51, 0, -1]} rot={[0, Math.PI / 2, 0]} faceName="SECTOR BETA" degraded={degraded} onSelect={setSelectedElement} />

        <gridHelper args={[100, 50, 0x083344, 0x0f172a]} position={[0, -7, 0]} />
      </Canvas>

      <div className="absolute top-4 left-4 z-10 pointer-events-none">
          <h1 className="glitch-text text-2xl font-bold text-cyan-400">LTAMDS Gen-4</h1>
          <p className="text-[10px] font-mono tracking-widest text-slate-400">ARRAY DIAGNOSTIC INTERFACE @[//] SECTOR 7G</p>
          <div className="mt-4 flex gap-4 text-[10px] font-mono">
              <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  CORE TEMP: <span id="overlay-core-temp">{coreTemp.toFixed(1)}</span>°C
              </div>
              <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-500"></span>
                  UPTIME: 1,422H
              </div>
          </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 text-[10px] font-mono text-cyan-500/70 uppercase tracking-tighter pointer-events-none">
          [LMB] ROTATE • [SCROLL] MAGNIFY • [CLICK] INTERROGATE
      </div>

      {/* Right Diagnostic HUD (Dynamic) */}
      <div className={`absolute right-4 top-16 w-72 hud-border p-4 z-20 transition-transform duration-500 transform ${selectedElement ? 'translate-x-0' : 'translate-x-[120%]'} pointer-events-auto`}>
          <div className="scanning-line"></div>
          <div className="flex justify-between items-start mb-4 relative z-10">
              <div>
                  <h2 className="text-lg font-bold glitch-text text-cyan-400">{selectedElement?.id || '--'}</h2>
                  <p className="text-[0.6rem] font-mono text-slate-400">PHASED ARRAY SECTOR: {selectedElement?.face || 'PRIMARY'}</p>
              </div>
              <button onClick={() => setSelectedElement(null)} className="text-cyan-400 hover:text-white transition-colors text-lg font-bold p-1 cursor-pointer">✕</button>
          </div>

          <div className="space-y-4 relative z-10">
              <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                      <p className="text-[0.6rem] text-slate-400 font-mono">THERMAL</p>
                      <p className="text-lg text-cyan-300"><span>{selectedElement?.temp || '--'}</span>°C</p>
                  </div>
                  <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                      <p className="text-[0.6rem] text-slate-400 font-mono">VOLTAGE</p>
                      <p className="text-lg text-cyan-300">24.2 <span className="text-xs">mV</span></p>
                  </div>
              </div>

              <div>
                  <p className="text-[0.6rem] text-slate-400 font-mono mb-1">SIGNAL INTEGRITY</p>
                  <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-400 transition-all duration-700" style={{ width: selectedElement ? `${Math.floor((1 - (selectedElement.healthValue > 0.94 ? 0.3 : 0.02)) * 100)}%` : '98%' }}></div>
                  </div>
              </div>

              <div className="pt-4 border-t border-cyan-900/50">
                  <div className="flex justify-between items-center font-mono text-xs">
                      <span className="text-slate-400">ELEMENT STATUS</span>
                      <span className={`px-2 py-0.5 rounded-sm font-bold ${selectedElement?.health === 'NOMINAL' ? 'bg-emerald-500/20 text-emerald-400' : selectedElement?.health === 'DEGRADED' ? 'bg-amber-500/20 text-amber-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {selectedElement?.health || 'NOMINAL'}
                      </span>
                  </div>
              </div>

              <button className="w-full py-1.5 bg-cyan-500 text-slate-950 font-bold font-mono text-xs hover:bg-cyan-400 transition-colors cursor-pointer">
                  RUN CALIBRATION
              </button>
          </div>
      </div>
    </div>
  );
}