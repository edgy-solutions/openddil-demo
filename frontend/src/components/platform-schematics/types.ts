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

/** Phase 5 ADR-0026: operational_state 3-axis posture surfaced into
 *  schematic rendering. Schematics can react to specific power / health
 *  states beyond the rolled-up `degraded` boolean — e.g. POWER_STATE_OFF
 *  kills all indicator activity (asset reads as "powered down" even when
 *  fusion hasn't said it's degraded). Optional and additive: schematics
 *  that don't read it stay nominal-vs-degraded only. */
export interface OperationalStatePosture {
  power_state: string | null;
  functional_mode: string | null;
  health_state: string | null;
  actively_receiving: boolean | null;
  actively_transmitting: boolean | null;
}

export interface SchematicProps {
  /** Drives indicator-strip color cycling on the schematic. true = warning
   *  amber / red; false = nominal emerald. Computed from logistics severity
   *  at the AssetVisual cascade level. */
  degraded: boolean;
  /** Phase 5 (ADR-0026): per-axis operational posture. Optional — when
   *  absent or null axes, the schematic falls back to the nominal-vs-
   *  degraded behavior driven by `degraded` alone. When present and
   *  non-null, schematics interpret specific values:
   *    POWER_STATE_OFF / SHUTTING_DOWN  -> all indicators dark
   *    POWER_STATE_MAINTENANCE           -> animation paused / neutral pose
   *    HEALTH_STATE_FAULT / FAILED       -> indicators strobe red
   *  Individual schematics implement only the subset relevant to their
   *  silhouette; unimplemented axes are ignored. */
  operationalState?: OperationalStatePosture | null;
}

/** Tier discriminator for sensor and interceptor schematics. Drives visual
 *  emphasis (dish size, label badge) without changing the base silhouette. */
export type SensorTier = 'CUAS' | 'VSHORAD' | 'SHORAD' | 'MRAD';

/** Sub-variant for facility schematics — distinguishes the headquarters
 *  visual from the generic air-defense site. */
export type FacilityVariant = 'HQ' | 'DEFAULT';
