// =============================================================================
// tint — per-frame status recolour that is safe in every render mode
// =============================================================================
// A schematic part's material depends on the render mode (SchematicMaterial):
// in holographic a solid part is the SHARED holo ShaderMaterial, which has no
// `color`. Recolouring it blindly throws every frame ("t.color is undefined").
// tint() recolours only a material that owns a THREE.Color and reports whether
// it did; the shared holo shader is never touched.
import * as THREE from 'three';

export function tint(material: THREE.Material | THREE.Material[] | null | undefined, hex: number): boolean {
  if (!material || Array.isArray(material)) return false;
  const color = (material as { color?: unknown }).color;
  if (!(color instanceof THREE.Color)) return false;
  color.setHex(hex);
  return true;
}
