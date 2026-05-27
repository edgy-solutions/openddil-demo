// =============================================================================
// platform-schematics — shared types
// =============================================================================
// Every schematic in this module is a pure-3D React Three Fiber component
// returning `<mesh>`/`<group>`/`<primitive>` only — no DOM. That makes them
// reusable across:
//
//   * Maintainer view (close-up, single asset, HudFrame-wrapped)
//   * Regional / HQ 3D maps (small scale, many assets, top-down camera)
//   * AssetDeepDive zoom-in (per-asset detail view)
//
// Common contract: `degraded: boolean` drives indicator-strip color cycling
// on each schematic. Map-tier consumers wire `degraded` from logistics
// severity (CRITICAL/DEGRADED → true). Maintainer wires it from the
// asset's CM/sustainment state.
//
// Per-platform variants (tier for sensors/interceptors, sub-variant for
// facilities) are component-specific extensions, not part of the base
// contract. They're baked into the SCHEMATIC_REGISTRY at registration
// time via closure so consumers can dispatch using only `{ degraded }`.
//
// ADR-0017 self-identifying-mock note: these are pure-3D primitives and
// cannot host a `<DemoMockBanner>` inline (DOM nodes can't live in a
// `<Canvas>`). The parent component that mounts the `<Canvas>` is
// responsible for any view-level mock-status banner.

export interface SchematicProps {
  /** Drives indicator-strip color cycling on the schematic. true = warning
   *  amber / red; false = nominal emerald. */
  degraded: boolean;
}

/** Tier discriminator for sensor and interceptor schematics. Drives visual
 *  emphasis (dish size, label badge) without changing the base silhouette. */
export type SensorTier = 'CUAS' | 'VSHORAD' | 'SHORAD' | 'MRAD';

/** Sub-variant for facility schematics — distinguishes the headquarters
 *  visual from the generic air-defense site. */
export type FacilityVariant = 'HQ' | 'DEFAULT';
