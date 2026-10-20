// A holographic terrain style, built from the elevation alone (no imagery), so a
// deployment can carry it offline. No bloom: the engagement inset takes over the
// render loop, so a post-processing composer would fight it.
// One shader on the draped heightfield: glowing coastline, land contours,
// sea-floor depth rings, a km grid, a dot-matrix "scan" field and a sweep.
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { UNITS_PER_KM } from '../../lib/sceneScale';
import { drape, type TerrainData } from './terrainData';
import { HUES, HOLO_DEFAULTS, type HoloOpts } from './holoOpts';
import type { EdgeRamp } from './theaterShaders';

const VERT = /* glsl */ `
attribute float hraw;
varying float vH;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vH = hraw;
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFloor, uStep, uSeaStep, uSeaLevel, uKm, uTime, uGlow, uDot;
uniform float uContours, uCoast, uDepth, uGrid, uDots, uSweep;
uniform vec2 uCenter;
uniform sampler2D uMask;
uniform float uHasMask;
// Optional edge mute, the surround's (see HOLO_FRAG in theaterShaders.ts): on only while a surround is drawn.
uniform float uEdge, uEdgeNear, uEdgeFar; uniform vec4 uTheater;
varying float vH;
varying vec3 vW;
varying vec2 vUv;

// Anti-aliased line on the integer values of v, about w px wide.
float isoLine(float v, float w) {
  float d = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-6);
  return 1.0 - clamp(d / w, 0.0, 1.0);
}
// Fades a family of lines out before they crowd closer than a few pixels.
float sparse(float v) { return 1.0 - smoothstep(0.08, 0.25, fwidth(v)); }

void main() {
  float m = texture2D(uMask, vUv).r;
  float land = uHasMask > 0.5 ? smoothstep(0.35, 0.65, m) : smoothstep(uSeaLevel - 0.3, uSeaLevel + 0.3, vH);
  float lift = clamp(vH / 20.0, 0.0, 1.0);
  vec3 col = mix(uColor * 0.012, uColor * (0.045 + 0.06 * lift), land);
  float glow = 0.0;

  // Sweep: a ring expanding from the centre every 10 s, with a fading wake.
  float s = 0.0;
  if (uSweep > 0.5) {
    float front = mod(uTime * 4.0, 40.0);
    float d = front - length(vW.xz - uCenter);
    s = d > 0.0 ? exp(-d / 1.2) : 0.0;
    s *= 1.0 - smoothstep(30.0, 40.0, front);
  }
  if (uContours > 0.5) { float v = vH / uStep; glow += 0.45 * land * smoothstep(uFloor - 0.5, uFloor, vH) * isoLine(v, 1.0) * sparse(v); }
  if (uDepth > 0.5) { float v = vH / uSeaStep; glow += 0.3 * (1.0 - land) * isoLine(v, 1.0) * sparse(v); }
  if (uCoast > 0.5) {
    float e = uHasMask > 0.5 ? abs(m - 0.5) / max(fwidth(m), 1e-4) : abs(vH - uSeaLevel) / max(fwidth(vH), 1e-4);
    glow += 1.2 * (1.0 - clamp(e / 1.5, 0.0, 1.0)) + 0.35 * exp(-e / 6.0);
  }
  if (uGrid > 0.5) {
    vec2 g = vW.xz / uKm;
    glow += 0.12 * max(isoLine(g.x, 1.0) * sparse(g.x), isoLine(g.y, 1.0) * sparse(g.y));
  }
  if (uDots > 0.5) {
    vec2 p = vW.xz / (uKm * uDot);
    float px = max(fwidth(p.x), 1e-6);
    float r = length(fract(p) - 0.5) / px; // pixels from the dot centre
    float pt = (1.0 - smoothstep(1.5, 2.5, r)) * (1.0 - smoothstep(0.15, 0.4, px));
    glow += pt * land * (0.35 + 0.65 * clamp(vH / 15.0, 0.0, 1.0));
  }
  vec2 qd = max(uTheater.xy - vW.xz, vW.xz - uTheater.zw);
  float sd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0);
  float em = uEdge * smoothstep(uEdgeNear, uEdgeFar, sd);
  col += uColor * (glow * uGlow * (1.0 + 2.5 * s) * (1.0 - 0.75 * em) + 0.06 * s);
  // As the surround: outside the rect stay under the bloom threshold.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= min(1.0, mix(1000.0, 0.14, em) / max(lum, 1e-5));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const f = (b: boolean) => (b ? 1 : 0);
const SEG = 500;

/** Separable box blur, radius r, of an n×n grid (edges clamped); run twice for a softer kernel. */
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

/** `center` is the scene (x, z) the scan sweep radiates from. `edge`: mute towards the rect edge like the surround. */
export function HoloTerrain({ data, exag, opts, center, edge }: {
  data: TerrainData; exag: number; opts: HoloOpts; center: [number, number]; edge?: EdgeRamp;
}) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, SEG, exag, data.rawM), [data, exag]);
  const raw = useMemo(() => (geometry.getAttribute('hraw').array as Float32Array).slice(), [geometry]);
  useEffect(() => {
    const a = geometry.getAttribute('hraw') as THREE.BufferAttribute;
    (a.array as Float32Array).set(blur(raw, SEG + 1, Math.round(opts.smooth)));
    a.needsUpdate = true;
  }, [geometry, raw, opts.smooth]);
  const wireGeo = useMemo(() => drape(data.heightM, data.bounds, data.proj, 120, exag), [data, exag]);
  useEffect(() => () => { geometry.dispose(); wireGeo.dispose(); }, [geometry, wireGeo]);
  const maskTex = useMemo(() => (data.mask ? new THREE.CanvasTexture(data.mask) : null), [data.mask]);
  useEffect(() => () => { maskTex?.dispose(); }, [maskTex]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      uFloor: { value: 1 }, uColor: { value: new THREE.Color() }, uStep: { value: 2 }, uSeaStep: { value: 5 }, uSeaLevel: { value: -2.5 },
      uKm: { value: UNITS_PER_KM }, uTime: { value: 0 }, uGlow: { value: 1 }, uDot: { value: 0.25 },
      uContours: { value: 1 }, uCoast: { value: 1 }, uDepth: { value: 1 }, uGrid: { value: 1 }, uDots: { value: 0 },
      uSweep: { value: 1 }, uCenter: { value: new THREE.Vector2() },
      uMask: { value: null as THREE.Texture | null }, uHasMask: { value: 0 },
      uEdge: { value: 0 }, uEdgeNear: { value: 0 }, uEdgeFar: { value: 1 }, uTheater: { value: new THREE.Vector4() },
    },
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  const u = material.uniforms;
  /* eslint-disable react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F) */
  u.uColor.value.set(HUES[opts.hue]);
  u.uStep.value = opts.step; u.uSeaStep.value = opts.seaStep; u.uSeaLevel.value = opts.seaLevel;
  u.uFloor.value = opts.floor; u.uGlow.value = opts.glow; u.uDot.value = opts.dot;
  u.uContours.value = f(opts.contours); u.uCoast.value = f(opts.coast); u.uDepth.value = f(opts.depth);
  u.uGrid.value = f(opts.grid); u.uDots.value = f(opts.dots); u.uSweep.value = f(opts.sweep);
  u.uCenter.value.set(center[0], center[1]);
  u.uMask.value = maskTex; u.uHasMask.value = maskTex ? 1 : 0;
  u.uEdge.value = edge ? 1 : 0;
  if (edge) { u.uEdgeNear.value = edge.near; u.uEdgeFar.value = edge.far; u.uTheater.value.set(...edge.rect); }
  /* eslint-enable react-hooks/immutability */
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  useFrame(({ clock }) => { u.uTime.value = clock.elapsedTime; });
  return (
    <>
      <mesh geometry={geometry} material={material} userData={{ insetHidden: true }} />
      {opts.wire && (
        <mesh geometry={wireGeo} position={[0, 0.001, 0]} userData={{ insetHidden: true }}>
          <meshBasicMaterial color={HUES[opts.hue]} wireframe transparent opacity={0.1} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}

// ---- controls ---------------------------------------------------------------
const box: React.CSSProperties = {
  width: 210, maxHeight: '60vh', overflowY: 'auto', padding: '8px 10px',
  background: 'rgba(15,23,42,0.88)', border: '1px solid #334155', borderRadius: 4,
  font: '10px ui-monospace, monospace', letterSpacing: '0.05em', color: '#cbd5e1',
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, margin: '3px 0' };

/** The holo style's options; the caller positions it (it is a popover). */
export function HoloPanel({ opts, set, masked = false }: { opts: HoloOpts; set: (o: HoloOpts) => void; masked?: boolean }) {
  const toggle = (k: keyof HoloOpts, label: string) => (
    <label style={row}>
      <span>{label}</span>
      <input type="checkbox" checked={opts[k] as boolean} onChange={(e) => set({ ...opts, [k]: e.target.checked })} />
    </label>
  );
  const slider = (k: keyof HoloOpts, label: string, min: number, max: number, step: number, unit: string, disabled = false) => (
    <label style={{ ...row, display: 'block', opacity: disabled ? 0.5 : 1 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{label}</span><span style={{ color: '#67e8f9' }}>{opts[k] as number}{unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={opts[k] as number} style={{ width: '100%' }} disabled={disabled}
        onChange={(e) => set({ ...opts, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <div style={box}>
      <div style={{ color: '#94a3b8', marginBottom: 4 }}>HOLO TERRAIN</div>
      {toggle('coast', 'Coastline')}
      {toggle('contours', 'Land contours')}
      {toggle('depth', 'Sea-floor contours')}
      {toggle('grid', 'Km grid')}
      {toggle('dots', 'Dot matrix')}
      {toggle('sweep', 'Scan sweep')}
      {toggle('wire', 'Wireframe')}
      {slider('step', 'Land contour step', 1, 10, 1, ' m')}
      {slider('seaStep', 'Sea contour step', 1, 20, 1, ' m')}
      {slider('seaLevel', masked ? 'Sea level cut (off: coastline data in use)' : 'Sea level cut', -6, 1, 0.5, ' m', masked)}
      {slider('smooth', 'Smoothing', 0, 6, 1, ' cells')}
      {slider('floor', 'Contours from', -2, 10, 0.5, ' m')}
      {slider('dot', 'Dot spacing', 0.05, 1, 0.05, ' km')}
      {slider('glow', 'Glow', 0.2, 3, 0.1, '×')}
      <div style={row}>
        <span>Colour</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {(Object.keys(HUES) as (keyof typeof HUES)[]).map((h) => (
            <button key={h} type="button" title={h} onClick={() => set({ ...opts, hue: h })}
              style={{ width: 14, height: 14, borderRadius: 7, background: HUES[h], border: opts.hue === h ? '2px solid #fff' : '1px solid #0f172a' }} />
          ))}
        </span>
      </div>
      <button type="button" onClick={() => set(HOLO_DEFAULTS)}
        style={{ marginTop: 4, width: '100%', border: '1px solid #334155', borderRadius: 3, padding: '2px 0', color: '#94a3b8' }}>
        RESET
      </button>
    </div>
  );
}
