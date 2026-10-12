// Pure derivation of METALLIC material parameters from a part's original
// (MATTE) standard-material props. Today's parts are near-black, highly
// metallic and lit without an environment map, so they read as black. This
// lifts very dark base colours toward a gunmetal/steel range while keeping
// hue and the relative ordering of lightness (hull vs skirt vs barrel stay
// distinguishable), and sets metal-appropriate PBR values.
import * as THREE from 'three';

export interface MetallicInput {
  color?: THREE.ColorRepresentation;
  metalness?: number;
  roughness?: number;
  [key: string]: unknown;
}

export const METALLIC_MIN_METALNESS = 0.6;
export const METALLIC_ROUGHNESS_RANGE: readonly [number, number] = [0.25, 0.6];

const LIFT = 0.32;
const LIFT_CEILING = 0.7;

/** Monotonic: lightness L -> L + LIFT * (1 - min(L, ceil) / ceil). */
export function liftLightness(l: number): number {
  return l + LIFT * (1 - Math.min(l, LIFT_CEILING) / LIFT_CEILING);
}

export function metallicParams(input: MetallicInput) {
  const { color, metalness, roughness, ...rest } = input;
  const c = new THREE.Color(color ?? 0xffffff);
  const hsl = { h: 0, s: 0, l: 0 };
  // sRGB-space HSL: the lift thresholds are perceptual, not linear.
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, hsl.s * 0.75, Math.min(0.9, liftLightness(hsl.l)), THREE.SRGBColorSpace);
  const [rMin, rMax] = METALLIC_ROUGHNESS_RANGE;
  return {
    ...rest,
    color: c.getHex(),
    metalness: Math.min(1, Math.max(METALLIC_MIN_METALNESS, metalness ?? 0.8)),
    roughness: Math.min(rMax, Math.max(rMin, roughness ?? 0.4)),
    clearcoat: 0.3,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1,
  };
}
