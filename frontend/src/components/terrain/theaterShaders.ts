// Shaders for the HQ theater terrain: a satellite and a holo style, each used for
// the theater layer and for the muted surround around it. Both styles mute by the
// signed distance to the theater rect (negative inside), on both layers, so the
// ramp starts inside the theater and the seam has no brightness step. uMask is the
// land/sea mask over the layer's own bounds (white = land).

export const SAT_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main() {
  vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const SAT_FRAG = /* glsl */ `
uniform sampler2D uMap, uMask; uniform vec4 uTheater; uniform vec3 uFadeColor; uniform float uSurround;
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main() {
  vec2 p = vW.xz;
  if (uSurround > 0.5) {
    vec2 inset = 0.01 * (uTheater.zw - uTheater.xy);
    if (all(greaterThan(p, uTheater.xy + inset)) && all(lessThan(p, uTheater.zw - inset))) discard;
  }
  vec2 qd = max(uTheater.xy - p, p - uTheater.zw);
  float sd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0);
  float m = smoothstep(-60.0, 400.0, sd);
  vec3 col = texture2D(uMap, vUv).rgb * vec3(0.66, 0.71, 0.77);
  col *= 0.6 + 0.4 * max(dot(normalize(vN), normalize(vec3(0.4, 1.0, 0.4))), 0.0);
  // One flat sea colour from the land mask: Esri's sea tone changes between zooms,
  // which showed as a box edge offshore between the two layers.
  float land = smoothstep(0.35, 0.65, texture2D(uMask, vUv).r);
  col = mix(vec3(0.035, 0.06, 0.095), col, land);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum), 0.8 * m) * (1.0 - 0.55 * m);
  col = mix(col, uFadeColor, smoothstep(1200.0, 3000.0, length(p)) * uSurround);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const HOLO_VERT = /* glsl */ `
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

export const HOLO_FRAG = /* glsl */ `
uniform vec3 uColor, uFadeColor;
uniform float uFloor, uStep, uSeaStep, uKm, uGlow, uSurround, uMute;
uniform vec4 uTheater; // world xz rect: minX, minZ, maxX, maxZ
uniform sampler2D uMask;
varying float vH;
varying vec3 vW;
varying vec2 vUv;

float isoLine(float v, float w) {
  float d = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-6);
  return 1.0 - clamp(d / w, 0.0, 1.0);
}
float sparse(float v) { return 1.0 - smoothstep(0.08, 0.25, fwidth(v)); }

void main() {
  vec2 p = vW.xz;
  vec2 qd = max(uTheater.xy - p, p - uTheater.zw);
  float sd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0);
  float m = uMute * smoothstep(-60.0, 400.0, sd);
  if (uSurround > 0.5) {
    vec2 inset = 0.01 * (uTheater.zw - uTheater.xy);
    if (all(greaterThan(p, uTheater.xy + inset)) && all(lessThan(p, uTheater.zw - inset))) discard;
  }
  float mask = texture2D(uMask, vUv).r;
  float land = smoothstep(0.35, 0.65, mask);
  float lift = clamp(vH / 20.0, 0.0, 1.0);
  vec3 col = mix(uColor * 0.012, uColor * (0.045 + 0.06 * lift), land);
  float glow = 0.0;
  { float v = vH / uStep; glow += 0.45 * land * smoothstep(uFloor - 0.5, uFloor, vH) * isoLine(v, 1.0) * sparse(v); }
  if (land < 0.5) { float v = vH / uSeaStep; glow += 0.3 * (1.0 - land) * isoLine(v, 1.0) * sparse(v); }
  {
    float e = abs(mask - 0.5) / max(fwidth(mask), 1e-4);
    glow += 1.2 * (1.0 - clamp(e / 1.5, 0.0, 1.0)) + 0.35 * exp(-e / 6.0);
  }
  {
    vec2 g = p / uKm;
    glow += 0.12 * max(isoLine(g.x, 1.0) * sparse(g.x), isoLine(g.y, 1.0) * sparse(g.y));
  }
  col += uColor * glow * uGlow * (1.0 - 0.75 * m);
  // Outside the theater: stay under the bloom threshold (luminance 0.2), so only the coast reads, dimly.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float cap = mix(1000.0, 0.14, m);
  col *= min(1.0, cap / max(lum, 1e-5));
  col = mix(col, uFadeColor, smoothstep(1200.0, 3000.0, length(p)) * uSurround);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
