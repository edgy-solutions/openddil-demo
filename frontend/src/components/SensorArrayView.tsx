// =============================================================================
// SensorArrayView — generic 3D sensor-array maintainer view
// =============================================================================
// Generalized from the original LtamdsView. The 3D scene machinery (depth
// drilling, element interrogation, scaling tweens, click-to-focus) is
// preserved exactly — the array-specific bits are now config-driven:
//
//   * Face count + layout at depth 0 (LTAMDS = 3 faces, MRAD = 1 face, etc.)
//   * Drill depth (how many internal layers you can drill into)
//   * Per-layer grid (cols × rows) at every internal depth
//   * Per-layer naming (breadcrumb label, element id prefix)
//   * Per-layer element sizing + spacing
//
// Health values are seeded per (assetId, depth, element_index) so each
// discovered asset gets its OWN consistent set of telemetry values across
// re-renders — no flicker between every frame, and each asset looks
// independent (matches the "independent telemetry values for each asset
// discovered" requirement for the MRAD sim). Pass `liveTelemetry` to
// override the seeded values with real per-element data from the sim
// service once that path is wired (see openddil-mrad-sim).
//
// ADR-0017: DEMO_MOCK marker carried on each config's bannerNote.
import { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import HudFrame from './HudFrame';

const COLORS = { nominal: 0x22d3ee, warning: 0xfacc15, critical: 0xef4444, bg: 0x020617, housing: 0x0f172a, card: 0x1e293b };

// ---------------------------------------------------------------------------
// Public config — fully data-driven so a new sensor array (MRAD, future
// AESAs, sonar, IR, whatever) is a config change, not a code change.
// ---------------------------------------------------------------------------
export interface FaceSpec {
    cols: number;
    rows: number;
    /** Local position of the face center, in the housing's frame. */
    pos: [number, number, number];
    /** Local rotation Euler, in the housing's frame. */
    rot: [number, number, number];
    /** Display name shown in the interrogation panel. */
    name: string;
}

export interface LayerSpec {
    /** Breadcrumb label for this depth (top header trail). */
    name: string;
    /** Grid columns at this depth. Depth 0 ignores this — faces drive layout. */
    cols: number;
    /** Grid rows at this depth. Depth 0 ignores this — faces drive layout. */
    rows: number;
    /** Element id prefix at this depth (e.g. "TR", "BOARD", "MODULE"). */
    prefix: string;
    /** Element box size [w, h, d] at this depth. */
    elementSize: [number, number, number];
    /** Grid spacing (center-to-center) at this depth. */
    spacing: number;
    /** Whether elements at this depth render as wireframe overlays (depth>0). */
    wireframe?: boolean;
}

export interface SensorArrayConfig {
    /** Top-left header — platform-specific identity. */
    title: string;
    /** Subtitle under the title. */
    subtitle: string;
    /** Face specs for depth 0 (the outer housing). One entry = single-face
     *  array like MRAD. Multiple entries = multi-face array like LTAMDS. */
    faces: FaceSpec[];
    /** Layers from depth 0 (outermost housing) to N (innermost). Length
     *  determines maximum drill depth. layers[0] only uses `name` +
     *  elementSize/spacing/wireframe (faces[] drives layout). layers[1..]
     *  fully drive a centered grid. */
    layers: LayerSpec[];
    /** Banner text passed to HudFrame (e.g. "DEMO_MOCK -- synthetic data"). */
    bannerNote: string;
    /** Outer housing bounding box [w, h, d] at depth 0. */
    housingSize: [number, number, number];
}

// ---------------------------------------------------------------------------
// LTAMDS_CONFIG — three-face AESA radar. Values lifted verbatim from the
// original LtamdsView so visual output is identical.
// ---------------------------------------------------------------------------
export const LTAMDS_CONFIG: SensorArrayConfig = {
    title: 'LTAMDS Gen-4',
    subtitle: 'ARRAY DIAGNOSTIC INTERFACE @[//] SECTOR 7G',
    faces: [
        { cols: 8, rows: 14, pos: [0, 0, 2.51], rot: [0, 0, 0], name: 'PRIMARY NORTH' },
        { cols: 5, rows: 8,  pos: [-3.51, 0, -1], rot: [0, -Math.PI / 2, 0], name: 'SECTOR ALPHA' },
        { cols: 5, rows: 8,  pos: [3.51, 0, -1],  rot: [0,  Math.PI / 2, 0], name: 'SECTOR BETA'  },
    ],
    layers: [
        { name: 'RADAR UNIT',       cols: 0, rows: 0, prefix: 'TR',     elementSize: [0.5, 0.5, 0.15], spacing: 0.65 },
        { name: 'PROCESSOR BANK',   cols: 2, rows: 2, prefix: 'BOARD',  elementSize: [6, 6, 0.5],     spacing: 8, wireframe: true },
        { name: 'SIGNAL CONVERTER', cols: 2, rows: 2, prefix: 'MODULE', elementSize: [4, 4, 0.5],     spacing: 6, wireframe: true },
        { name: 'GAN MMIC CHIP',    cols: 2, rows: 2, prefix: 'CHIP',   elementSize: [2, 2, 0.5],     spacing: 3, wireframe: true },
    ],
    bannerNote: 'live data wiring pending RTI/Cyber DDS integration',
    housingSize: [7, 12, 5],
};

// ---------------------------------------------------------------------------
// MRAD_CONFIG — single-face Multi-Mission Radar variant. Same LTAMDS visual
// family (grey/slate housing, cyan element highlights, glitch text), but
// one face. Per-layer cols/rows/naming tuned for the MRAD's narrower drill
// tree (backplane → processor → MMIC). The mrad-sim Python service
// publishes per-element telemetry into mrad_element_telemetry; this
// component falls back to seeded-RNG synthesis when no live data yet.
// ---------------------------------------------------------------------------
export const MRAD_CONFIG: SensorArrayConfig = {
    title: 'MRAD Multi-Mission Radar',
    subtitle: 'ARRAY DIAGNOSTIC INTERFACE @[//] FORWARD-DEPLOYED',
    faces: [
        { cols: 8, rows: 12, pos: [0, 0, 2.51], rot: [0, 0, 0], name: 'PRIMARY APERTURE' },
    ],
    layers: [
        { name: 'RADAR UNIT',     cols: 0, rows: 0, prefix: 'TR',     elementSize: [0.5, 0.5, 0.15], spacing: 0.65 },
        { name: 'BACKPLANE',      cols: 2, rows: 3, prefix: 'BOARD',  elementSize: [4, 4, 0.5],     spacing: 6, wireframe: true },
        { name: 'PROCESSOR BANK', cols: 2, rows: 2, prefix: 'MODULE', elementSize: [3, 3, 0.5],     spacing: 5, wireframe: true },
        { name: 'GAN MMIC CHIP',  cols: 3, rows: 3, prefix: 'CHIP',   elementSize: [1.5, 1.5, 0.4], spacing: 2.5, wireframe: true },
    ],
    bannerNote: 'DEMO_MOCK -- per-element telemetry from openddil-mrad-sim (synthesized when sim absent)',
    housingSize: [6, 9, 5],
};

const tweenGroup = new TWEEN.Group();

function getStatusFromHealth(health: number) {
    if (health > 0.97) return { color: COLORS.critical, label: "CRITICAL", class: "bg-red-500/20 text-red-400" };
    if (health > 0.90) return { color: COLORS.warning, label: "DEGRADED", class: "bg-yellow-500/20 text-yellow-400" };
    return { color: COLORS.nominal, label: "NOMINAL", class: "bg-green-500/20 text-green-400" };
}

interface ElementData {
    id: string;
    face: string;
    temp: string;
    load: string;
    healthValue: number;
    status: any;
    pos: [number, number, number];
    rot?: [number, number, number];
    size: [number, number, number];
    color: number;
    wireframe?: boolean;
}

// ---------------------------------------------------------------------------
// Seeded RNG so each asset_id gets a STABLE set of element values across
// re-renders (no jitter every frame) AND is independent from every other
// asset (no two assets share the same "broken element" pattern). Replace
// with live mrad-sim data via the `liveTelemetry` prop once the data
// path is in place.
// ---------------------------------------------------------------------------
function hashStringToSeed(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed: number): () => number {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Per-element telemetry from a live source (logistics-sim). Keyed
 *  by the same element id this view generates
 *  (`<prefix>-<face>-<i>-<j>` for face elements, `<prefix>-<i>-<j>`
 *  for internal layers). When provided, health/temp/load override the
 *  seeded synthesis; txActive/rxActive reflect the customer-sim-
 *  reported actively_transmitting / actively_receiving bits so the
 *  interrogation panel can show "TX off" / "RX off" badges that match
 *  the customer feed exactly. */
export interface LiveElementTelemetry {
    [elementId: string]: {
        health: number;
        temp?: number;
        load?: number;
        txActive?: boolean;
        rxActive?: boolean;
    };
}

function generateElements(
    depth: number,
    degraded: boolean,
    faces: FaceSpec[],
    layers: LayerSpec[],
    assetId: string,
    liveTelemetry?: LiveElementTelemetry,
): ElementData[] {
    const elements: ElementData[] = [];
    const layer = layers[depth];
    if (!layer) return elements;

    const rng = mulberry32(hashStringToSeed(`${assetId}|${depth}`));

    const synthHealth = (degradedRoll: () => number): number => {
        let health = rng();
        // 15% degraded population becomes near-critical when the operational
        // posture flags this asset as degraded — keeps the "everything red
        // when broken" demo intuitive without inventing fake fault paths.
        if (degraded && degradedRoll() > 0.85) health = 0.98;
        return health;
    };

    if (depth === 0) {
        // Depth 0 = outer housing surface. faces[] drives the layout; each
        // face's cols/rows lay out a planar grid that's then transformed
        // into the housing's frame.
        for (const spec of faces) {
            const { cols, rows, pos, rot, name } = spec;
            const spacing = layer.spacing;
            for (let i = 0; i < cols; i++) {
                for (let j = 0; j < rows; j++) {
                    const elementId = `${layer.prefix}-${name.replace(/\s+/g, '')}-${i}-${j}`;
                    const live = liveTelemetry?.[elementId];
                    const health = live?.health ?? synthHealth(rng);
                    const status = getStatusFromHealth(health);
                    const temp = live?.temp ?? (30 + health * 40);
                    const load = live?.load ?? (rng() * 100);

                    const localPos = new THREE.Vector3((i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0);
                    localPos.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
                    localPos.add(new THREE.Vector3(...pos));

                    elements.push({
                        id: elementId,
                        face: name,
                        temp: temp.toFixed(1),
                        load: load.toFixed(0),
                        healthValue: health,
                        status,
                        pos: [localPos.x, localPos.y, localPos.z],
                        rot,
                        size: layer.elementSize,
                        color: status.color,
                    });
                }
            }
        }
    } else {
        // Internal layer — centered cols×rows grid in the housing's z=0 plane.
        const { cols, rows, prefix, spacing, elementSize, wireframe } = layer;
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                const elementId = `${prefix}-${i}-${j}`;
                const live = liveTelemetry?.[elementId];
                const health = live?.health ?? synthHealth(rng);
                const status = getStatusFromHealth(health);
                const temp = live?.temp ?? (35 + health * 50);
                const load = live?.load ?? (20 + rng() * 70);

                elements.push({
                    id: elementId,
                    face: 'INTERNAL',
                    temp: temp.toFixed(1),
                    load: load.toFixed(0),
                    healthValue: health,
                    status,
                    pos: [(i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0],
                    rot: [0, 0, 0],
                    size: elementSize,
                    color: COLORS.card,
                    wireframe: wireframe ?? true,
                });
            }
        }
    }
    return elements;
}

function SceneController({ currentDepth, onDrillDown, onInterrogate, isTransitioning, setIsTransitioning, degraded, faces, layers, assetId, liveTelemetry, housingSize }: any) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const groupsRef = useRef<THREE.Group[]>([]);

    const [selectedMesh, setSelectedMesh] = useState<THREE.Mesh | null>(null);

    // One memoized element list per layer. Recomputes only when degraded /
    // faces / layers / assetId / liveTelemetry actually change — element
    // values stay rock-stable across the per-frame useFrame loop.
    const elementsByDepth = useMemo(
        () => layers.map((_: LayerSpec, d: number) =>
            generateElements(d, degraded, faces, layers, assetId, liveTelemetry),
        ),
        [degraded, faces, layers, assetId, liveTelemetry],
    );

    useFrame(() => {
        tweenGroup.update();
    });

    useEffect(() => {
        // Instantly reset camera on depth change
        const targetCamPos = currentDepth === 0 ? new THREE.Vector3(15, 12, 20) : new THREE.Vector3(0, 0, 15);
        const targetLookAt = new THREE.Vector3(0, 0, 0);

        camera.position.copy(targetCamPos);
        camera.lookAt(targetLookAt);

        if (controlsRef.current) {
            controlsRef.current.target.copy(targetLookAt);
            controlsRef.current.update();
        }

        // Scale in new group
        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            activeGroup.scale.set(0.1, 0.1, 0.1);
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 1, y: 1, z: 1 }, 600)
                .easing(TWEEN.Easing.Back.Out)
                .onComplete(() => {
                    if (controlsRef.current) {
                        controlsRef.current.enabled = true;
                        controlsRef.current.enableDamping = true;
                    }
                    setIsTransitioning(false);
                })
                .start();
        } else {
            if (controlsRef.current) {
                controlsRef.current.enabled = true;
                controlsRef.current.enableDamping = true;
            }
            setIsTransitioning(false);
        }
    }, [currentDepth, camera, setIsTransitioning]);

    const handleSelect = (data: ElementData, mesh: THREE.Mesh) => {
        if (isTransitioning) return;

        // Cancel any ongoing tweens
        tweenGroup.removeAll();

        setIsTransitioning(true);
        if (controlsRef.current) {
            controlsRef.current.enabled = false;
        }

        if (selectedMesh && selectedMesh !== mesh) {
            selectedMesh.scale.set(1, 1, 1);
        }

        setSelectedMesh(mesh);
        onInterrogate(data);

        new TWEEN.Tween(mesh.scale, tweenGroup)
            .to({ x: 1.2, y: 1.2, z: 2 }, 300)
            .easing(TWEEN.Easing.Back.Out)
            .start();

        const targetPos = new THREE.Vector3();
        mesh.getWorldPosition(targetPos);

        const offset = new THREE.Vector3(0, 0, currentDepth === 0 ? 5 : 8);
        offset.applyQuaternion(mesh.quaternion);
        if (currentDepth > 0) offset.z = 10;

        const newCamPos = targetPos.clone().add(offset);

        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: newCamPos.x, y: newCamPos.y, z: newCamPos.z }, 1000)
            .easing(TWEEN.Easing.Quadratic.Out)
            .onUpdate(() => {
                camera.lookAt(targetPos);
            })
            .onComplete(() => {
                if (controlsRef.current) {
                    controlsRef.current.target.copy(targetPos);
                    controlsRef.current.enabled = true;
                    controlsRef.current.update();
                }
                setIsTransitioning(false);
            })
            .start();
    };

    const handleDrillDown = (_data: ElementData, _mesh: THREE.Mesh) => {
        // Cancel any ongoing tweens (like the single-click zoom)
        tweenGroup.removeAll();

        setIsTransitioning(true);
        if (controlsRef.current) {
            controlsRef.current.enabled = false;
        }
        onInterrogate(null); // hide HUD

        if (selectedMesh) {
            selectedMesh.scale.set(1, 1, 1);
            setSelectedMesh(null);
        }

        const targetPos = new THREE.Vector3();
        _mesh.getWorldPosition(targetPos);

        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 800)
            .easing(TWEEN.Easing.Exponential.In)
            .onUpdate(() => {
                camera.lookAt(targetPos);
            })
            .onComplete(() => {
                onDrillDown();
            })
            .start();

        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 5, y: 5, z: 5 }, 800)
                .easing(TWEEN.Easing.Exponential.In)
                .start();
        }
    };
    const handlePointerMissed = () => {
        if (selectedMesh) {
            new TWEEN.Tween(selectedMesh.scale, tweenGroup).to({ x: 1, y: 1, z: 1 }, 300).start();
            setSelectedMesh(null);
            onInterrogate(null);
        }
    };

    return (
        <>
            <OrbitControls
                ref={controlsRef}
                enableDamping
                dampingFactor={0.05}
                enableRotate={!isTransitioning}
                enableZoom={!isTransitioning}
                enablePan={!isTransitioning}
            />
            <group onPointerMissed={handlePointerMissed}>
                {elementsByDepth.map((elements: ElementData[], depth: number) => (
                    <group
                        key={depth}
                        ref={el => { if (el) groupsRef.current[depth] = el; }}
                        visible={currentDepth === depth}
                    >
                        {depth === 0 && (
                            <mesh>
                                <boxGeometry args={housingSize} />
                                <meshPhongMaterial color={COLORS.housing} transparent opacity={0.9} />
                                <lineSegments>
                                    <edgesGeometry args={[new THREE.BoxGeometry(...housingSize)]} />
                                    <lineBasicMaterial color={0x334155} transparent opacity={0.5} />
                                </lineSegments>
                            </mesh>
                        )}
                        {elements.map((data) => (
                            <ElementMesh
                                key={data.id}
                                data={data}
                                onSelect={handleSelect}
                                onDrillDown={handleDrillDown}
                            />
                        ))}
                    </group>
                ))}
            </group>
        </>
    );
}

function ElementMesh({ data, onSelect, onDrillDown }: { data: ElementData, onSelect: any, onDrillDown: any }) {
    const meshRef = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        if (meshRef.current && data.healthValue > 0.9) {
            const time = state.clock.getElapsedTime();
            const pulse = 0.5 + Math.sin(time * 5) * 0.5;
            (meshRef.current.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.4 + pulse * 1.5;
        }
    });

    return (
        <mesh
            ref={meshRef}
            position={data.pos}
            rotation={data.rot || [0, 0, 0]}
            onClick={(e) => { e.stopPropagation(); onSelect(data, meshRef.current); }}
            onDoubleClick={(e) => { e.stopPropagation(); onDrillDown(data, meshRef.current); }}
        >
            <boxGeometry args={data.size} />
            <meshPhongMaterial
                color={data.color}
                emissive={data.status.color}
                emissiveIntensity={data.healthValue > 0.9 ? 0.6 : 0.1}
            />
            {data.wireframe && (
                <lineSegments>
                    <edgesGeometry args={[new THREE.BoxGeometry(...data.size)]} />
                    <lineBasicMaterial color={data.status.color} transparent opacity={0.3} />
                </lineSegments>
            )}
        </mesh>
    );
}

interface SensorArrayViewProps {
    degraded: boolean;
    coreTemp: number;
    /** Config for the specific sensor array being rendered. Defaults to
     *  LTAMDS_CONFIG. Pass MRAD_CONFIG for MRAD variants. */
    config?: SensorArrayConfig;
    /** Asset id used as the seed for per-element synthesis. Different
     *  assets get different (consistent) telemetry sets. Default 'unknown'. */
    assetId?: string;
    /** Live per-element telemetry from openddil-mrad-sim. Optional — when
     *  absent, the view falls back to seeded-RNG synthesis. */
    liveTelemetry?: LiveElementTelemetry;
}

export default function SensorArrayView({ degraded, coreTemp, config = LTAMDS_CONFIG, assetId = 'unknown', liveTelemetry }: SensorArrayViewProps) {
    const [currentDepth, setCurrentDepth] = useState(0);
    const [selectedElement, setSelectedElement] = useState<ElementData | null>(null);
    const [isTransitioning, setIsTransitioning] = useState(false);

    const maxDepth = config.layers.length;

    const handleDrillDown = () => {
        setCurrentDepth(prev => (prev + 1) % maxDepth);
    };

    const handleInterrogate = (data: ElementData | null) => {
        setSelectedElement(data);
    };

    const headerExtras = (
        <>
            <div className="mt-4 flex gap-2 text-[0.6rem] font-bold uppercase tracking-widest text-cyan-500/50">
                {config.layers.slice(0, currentDepth + 1).map((layer, i) => (
                    <span key={i} className="flex items-center gap-2">
                        <span className={i === currentDepth ? 'text-cyan-400' : ''}>{layer.name}</span>
                        {i < currentDepth && <span className="opacity-30">/</span>}
                    </span>
                ))}
            </div>
            <div className="mt-4 flex gap-4 text-[10px] font-mono">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    CORE TEMP: <span>{coreTemp.toFixed(1)}</span>°C
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-cyan-500"></span>
                    UPTIME: 1,422H
                </div>
            </div>
        </>
    );

    return (
        <HudFrame
            title={config.title}
            subtitle={config.subtitle}
            bannerNote={config.bannerNote}
            bottomHint="[CLICK] FOCUS & INTERROGATE • [DBL-CLICK] DRILL DOWN • [SCROLL] ZOOM"
            headerExtras={headerExtras}
        >
            <Canvas camera={{ position: [15, 12, 20], fov: 50 }}>
                <color attach="background" args={[COLORS.bg]} />
                <fogExp2 attach="fog" args={[COLORS.bg, 0.05]} />
                <ambientLight intensity={0.4} />
                <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />

                <SceneController
                    currentDepth={currentDepth}
                    onDrillDown={handleDrillDown}
                    onInterrogate={handleInterrogate}
                    isTransitioning={isTransitioning}
                    setIsTransitioning={setIsTransitioning}
                    degraded={degraded}
                    faces={config.faces}
                    layers={config.layers}
                    assetId={assetId}
                    liveTelemetry={liveTelemetry}
                    housingSize={config.housingSize}
                />
            </Canvas>

            {/* Depth indicator — one tick per configured layer. */}
            <div className="absolute bottom-6 right-6 z-10 flex gap-2 pointer-events-none">
                {config.layers.map((_, i) => (
                    <div key={i} className={`w-8 h-1 ${i <= currentDepth ? 'bg-cyan-400' : 'bg-slate-800'}`}></div>
                ))}
            </div>

            {/* Right Diagnostic HUD */}
            <div className={`absolute right-6 top-6 w-80 hud-border p-6 z-20 transition-transform duration-500 transform ${selectedElement ? 'translate-x-0' : 'translate-x-[120%]'} pointer-events-auto`}>
                <div className="scanning-line"></div>
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 className="text-lg font-bold glitch-text text-cyan-400">{selectedElement?.id || '--'}</h2>
                        <p className="text-[0.6rem] opacity-60 uppercase">{selectedElement?.face || 'SYSTEM COMPONENT'}</p>
                    </div>
                    <button onClick={() => {
                        setSelectedElement(null);
                    }} className="text-cyan-400 hover:text-white transition-colors text-xl font-bold p-1 cursor-pointer">✕</button>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                        <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                            <p className="text-[0.6rem] opacity-50">THERMAL</p>
                            <p className="text-lg text-cyan-300"><span>{selectedElement?.temp || '--'}</span>°C</p>
                        </div>
                        <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                            <p className="text-[0.6rem] opacity-50">LOAD</p>
                            <p className="text-lg text-cyan-300"><span>{selectedElement?.load || '--'}</span>%</p>
                        </div>
                    </div>

                    <div>
                        <p className="text-[0.6rem] opacity-50 mb-1">SIGNAL INTEGRITY</p>
                        <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                            <div
                                className="h-full transition-all duration-700"
                                style={{
                                    width: selectedElement ? `${Math.max(5, Math.floor((1 - (selectedElement.healthValue > 0.9 ? 0.4 : 0.02)) * 100))}%` : '98%',
                                    backgroundColor: selectedElement ? `#${selectedElement.status.color.toString(16).padStart(6, '0')}` : '#22d3ee',
                                }}
                            ></div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-cyan-900/50">
                        <div className="flex justify-between items-center">
                            <span className="text-xs">STATUS</span>
                            <span className={`px-2 py-0.5 rounded text-[0.7rem] font-bold ${selectedElement?.status.class || 'bg-green-500/20 text-green-400'}`}>
                                {selectedElement?.status.label || 'NOMINAL'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </HudFrame>
    );
}
