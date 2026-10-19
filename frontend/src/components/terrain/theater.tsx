// The HQ map's terrain: the theater at full brightness and a muted, faded surround
// out to ~8 degrees, in the satellite or the holo style. Theater, surround and the
// land mask load independently and each draws as soon as it arrives.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { drape, type TerrainData } from './terrainData';
import { HOLO_DEFAULTS, HUES } from './holoOpts';
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

function SatLayer({ data, exag, rect, mask, surround = false }: {
  data: TerrainData; exag: number; rect: Rect; mask: THREE.Texture | null; surround?: boolean;
}) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, surround ? 300 : 400, exag), [data, exag, surround]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SAT_VERT, fragmentShader: SAT_FRAG,
    polygonOffset: surround, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // the surround sits behind the theater at the overlap
    uniforms: {
      uMap: { value: data.texture }, uTheater: { value: new THREE.Vector4(...rect) },
      uFadeColor: { value: new THREE.Color(BG) }, uSurround: { value: surround ? 1 : 0 }, uMask: { value: null },
    },
  }), [data, rect, surround]);
  useEffect(() => () => material.dispose(), [material]);
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uMask.value = mask ?? landFallback();
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
function HoloLayer({ data, exag, rect, mask, surround = false }: {
  data: TerrainData; exag: number; rect: Rect; mask: THREE.Texture | null; surround?: boolean;
}) {
  const opts = HOLO_DEFAULTS;
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
    uniforms: {
      uColor: { value: new THREE.Color(HUES[opts.hue]) }, uFadeColor: { value: new THREE.Color(BG) },
      uFloor: { value: opts.floor }, uStep: { value: opts.step }, uSeaStep: { value: opts.seaStep },
      uKm: { value: HOLO_KM }, uGlow: { value: 1 }, uSurround: { value: surround ? 1 : 0 }, uMute: { value: 1 },
      uTheater: { value: new THREE.Vector4(...rect) }, uMask: { value: null },
    },
  }), [opts, rect, surround]);
  useEffect(() => () => material.dispose(), [material]);
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  material.uniforms.uMask.value = mask ?? landFallback();
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
      {surround && <Layer data={surround} exag={exag} rect={rect} mask={mask.surround} surround />}
    </group>
  );
}
