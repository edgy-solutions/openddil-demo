// The HQ map's terrain: the theater at full brightness and a muted, faded surround
// out to ~8 degrees, in the satellite or the holo style. Theater, surround and the
// land mask load independently and each draws as soon as it arrives.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { drape, type TerrainData } from './terrainData';
import { HOLO_DEFAULTS, HUES, type HoloOpts } from './holoOpts';
import { UNITS_PER_KM } from '../../lib/sceneScale';
import { HQ_SCALE, HQ_UNITS_PER_DEG, type Rect, type TheaterTerrainData } from './theaterData';
import type { TerrainStyle } from './prefs';
import { HOLO_FRAG, HOLO_VERT, SAT_FRAG, SAT_VERT } from './theaterShaders';

const BG = 0x020617; // the HQ canvas background
const HOLO_KM = 10 * (HQ_UNITS_PER_DEG / 111); // holo grid: 10 km in HQ world units

// Stands in for a mask that is not (or never will be) there: everything is land.
let allLand: THREE.DataTexture | null = null;
function landFallback(): THREE.Texture {
  if (!allLand) {
    allLand = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    allLand.needsUpdate = true;
  }
  return allLand;
}

/** HQ-unit distances the shaders use (edge mute ramp, fade to the background), scaled by `unit` (1 at HQ). */
function distanceUniforms(unit: number) {
  return {
    uEdgeNear: { value: -60 * unit }, uEdgeFar: { value: 400 * unit },
    uFadeNear: { value: 1200 * unit }, uFadeFar: { value: 3000 * unit },
  };
}

/**
 * `unit`: world units per HQ unit (1 on the HQ map, 1 / HQ_SCALE on the regional map). `fog`: take the scene fog.
 * The rest make the regional surround match the regional terrain it borders (HQ passes none): `desat` and
 * `bright` (sat: the terrain's base desaturation and the brightness slider), `holo` (the holo options),
 * `gridKm` (holo: grid spacing in world units).
 */
interface LayerProps {
  data: TerrainData; exag: number; rect: Rect; mask: THREE.Texture | null; surround?: boolean; cut?: boolean;
  unit?: number; fog?: boolean; desat?: number; bright?: number; holo?: HoloOpts; gridKm?: number;
}

export function SatLayer({ data, exag, rect, mask, surround = false, cut = true, unit = 1, fog = false, desat = 0, bright = 1 }: LayerProps) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, surround ? 300 : 400, exag), [data, exag, surround]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SAT_VERT, fragmentShader: SAT_FRAG,
    polygonOffset: surround, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // the surround sits behind the theater at the overlap
    fog,
    uniforms: {
      ...(fog ? THREE.UniformsUtils.clone(THREE.UniformsLib.fog) : {}),
      uMap: { value: data.texture }, uTheater: { value: new THREE.Vector4(...rect) },
      uFadeColor: { value: new THREE.Color(BG) }, uSurround: { value: surround ? 1 : 0 }, uCut: { value: 1 }, uMask: { value: null },
      ...distanceUniforms(unit), uDesat: { value: desat }, uBright: { value: 1 },
    },
  }), [data, rect, surround, unit, fog, desat]);
  useEffect(() => () => material.dispose(), [material]);
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uMask.value = mask ?? landFallback();
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uCut.value = cut ? 1 : 0; // set here, not in the memo: no rebuild when the theater arrives
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uBright.value = bright;
  return <mesh geometry={geometry} material={material} userData={{ insetHidden: true }} />;
}

function blur(src: Float32Array, n: number, r: number): Float32Array {
  if (r <= 0) return src;
  const a = src.slice();
  const b = new Float32Array(a.length);
  const pass = (from: Float32Array, to: Float32Array, horiz: boolean) => {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const t = Math.min(n - 1, Math.max(0, i + k));
          sum += horiz ? from[j * n + t] : from[t * n + j];
        }
        to[horiz ? j * n + i : i * n + j] = sum / (2 * r + 1);
      }
    }
  };
  for (let it = 0; it < 2; it++) { pass(a, b, true); pass(b, a, false); }
  return a;
}

/** The holo style: the surround layer is the same shader with the theater rect cut out of it. */
export function HoloLayer({ data, exag, rect, mask, surround = false, cut = true, unit = 1, fog = false, holo, gridKm }: LayerProps) {
  const opts = holo ?? HOLO_DEFAULTS;
  const segments = surround ? 400 : 500;
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, segments, exag, data.rawM), [data, exag, segments]);
  useEffect(() => {
    const a = geometry.getAttribute('hraw') as THREE.BufferAttribute;
    (a.array as Float32Array).set(blur((a.array as Float32Array).slice(), segments + 1, Math.round(opts.smooth)));
    a.needsUpdate = true;
  }, [geometry, segments, opts.smooth]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    polygonOffset: surround, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // the surround sits behind the theater at the overlap
    fog,
    uniforms: {
      ...(fog ? THREE.UniformsUtils.clone(THREE.UniformsLib.fog) : {}),
      ...distanceUniforms(unit),
      uColor: { value: new THREE.Color(HUES[opts.hue]) }, uFadeColor: { value: new THREE.Color(BG) },
      uFloor: { value: opts.floor }, uStep: { value: opts.step }, uSeaStep: { value: opts.seaStep },
      uKm: { value: gridKm ?? HOLO_KM * unit }, uGlow: { value: opts.glow }, uSurround: { value: surround ? 1 : 0 }, uMute: { value: 1 }, uCut: { value: 1 },
      uContours: { value: opts.contours ? 1 : 0 }, uDepth: { value: opts.depth ? 1 : 0 },
      uCoast: { value: opts.coast ? 1 : 0 }, uGrid: { value: opts.grid ? 1 : 0 },
      uTheater: { value: new THREE.Vector4(...rect) }, uMask: { value: null },
    },
  }), [opts, rect, surround, unit, fog, gridKm]);
  useEffect(() => () => material.dispose(), [material]);
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uMask.value = mask ?? landFallback();
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uCut.value = cut ? 1 : 0; // set here, not in the memo: no rebuild when the theater arrives
  return <mesh geometry={geometry} material={material} userData={{ insetHidden: true }} />;
}

/** Inside the Canvas. Draws whatever of the theater and surround has loaded. */
export function TheaterTerrain({ data, style, exag }: { data: TheaterTerrainData; style: TerrainStyle; exag: number }) {
  const { theater, surround, mask, rect } = data;
  const Layer = style === 'holo' ? HoloLayer : SatLayer;
  if (!rect) return null;
  return (
    <group scale={HQ_SCALE}>
      {theater && <Layer data={theater} exag={exag} rect={rect} mask={mask.theater} />}
      {surround && <Layer data={surround} exag={exag} rect={rect} mask={mask.surround} surround cut={!!theater} />}
    </group>
  );
}

/**
 * Inside the regional Canvas: the muted, faded surround around the regional terrain, in the scene's own units
 * (no HQ group scale), so the fade distances are the HQ ones divided by HQ_SCALE. `rect` is the regional
 * terrain's bounds in world x/z; `cut` leaves a hole for it once it is drawn. It matches the terrain it
 * borders: the sat brightness slider and base desaturation, the holo options, and the terrain's 1 km grid
 * (which thins out with distance exactly as the terrain's does). Only the sat surround takes the scene fog,
 * as only the sat terrain does.
 */
export function RegionalSurround({ data, style, exag, rect, mask, cut, brightness, holo }: {
  data: TerrainData; style: TerrainStyle; exag: number; rect: Rect; mask: THREE.Texture | null; cut: boolean;
  brightness: number; holo: HoloOpts;
}) {
  const unit = 1 / HQ_SCALE;
  return style === 'holo'
    ? <HoloLayer data={data} exag={exag} rect={rect} mask={mask} surround cut={cut} unit={unit} holo={holo} gridKm={UNITS_PER_KM} />
    : <SatLayer data={data} exag={exag} rect={rect} mask={mask} surround cut={cut} unit={unit} fog desat={0.25} bright={brightness} />;
}
