// =============================================================================
// munitionAsset -- helpers for the in-flight MUNITION-class row family
// =============================================================================
// The parent launcher of an in-flight munition is read from the launch
// table: effector_launch carries one row per Fire, with the munition entity
// (munition_asset_id), the firing launcher (launcher_asset_id) and the Fire's
// event_urn. A munition with no launch row has no declared launcher; it is
// shown as such and never guessed, because asset_id is opaque and is not
// parsed for a launcher or a sequence.
//
// Firing identity is (parent launcher, launch event_urn). The producer may
// emit a delivery-vehicle row and a seeker-payload row per firing; rows that
// resolve to the same launch collapse to one, and rows with no launch row
// stay as themselves.
// =============================================================================

/** The slice of an effector_launch row needed to attribute a munition. */
export interface LaunchRef {
  launcher_asset_id: string;
  event_urn: string;
}

/** Index launch rows by munition entity. Rows with no munition_asset_id are
 *  skipped; they cannot be joined to a fleet row. */
export function launchesByMunition(
  rows: ReadonlyArray<{
    munition_asset_id: string | null;
    launcher_asset_id: string;
    event_urn: string;
  }>,
): Map<string, LaunchRef> {
  const out = new Map<string, LaunchRef>();
  for (const r of rows) {
    if (r.munition_asset_id === null) continue;
    out.set(r.munition_asset_id, {
      launcher_asset_id: r.launcher_asset_id,
      event_urn: r.event_urn,
    });
  }
  return out;
}

/**
 * A stable identity for a firing = (parent_launcher, launch event_urn).
 * Rows resolving to the same launch share this identity; dedup by this key.
 *
 * When either component is unknown, falls back to the asset_id itself
 * so we still count the row rather than dropping it silently.
 */
export function firingIdentity(
  assetId: string,
  parentLauncherId: string | null,
  firingEventUrn: string | null,
): string {
  if (parentLauncherId !== null && firingEventUrn !== null) {
    return `${parentLauncherId}#${firingEventUrn}`;
  }
  return `raw:${assetId}`;
}

/**
 * Given a list of MUNITION-class rows carrying (parent_launcher,
 * firing_event_urn, platform_variant), return one representative row per
 * firing. Preference order:
 *   1. Interceptor variant (delivery vehicle) over MISSILE_LAUNCHER
 *      (seeker payload) -- the interceptor's variant carries the
 *      munition-type discriminator we need for aggregation.
 *   2. Shorter asset_id if variants tie (the seeker row typically
 *      has an extra suffix appended).
 *
 * Rows for which we couldn't derive a firing identity survive as
 * themselves (no dedup applied) -- that's honest under-dedup rather
 * than silent-drop.
 */
export interface DedupCandidate {
  asset_id: string;
  platform_variant: string | null;
  parent_launcher_id: string | null;
  firing_event_urn: string | null;
}

export function dedupFirings<T extends DedupCandidate>(rows: T[]): T[] {
  const byFiring = new Map<string, T>();
  for (const r of rows) {
    const key = firingIdentity(r.asset_id, r.parent_launcher_id, r.firing_event_urn);
    const existing = byFiring.get(key);
    if (!existing) {
      byFiring.set(key, r);
      continue;
    }
    if (preferForFiring(r, existing)) {
      byFiring.set(key, r);
    }
  }
  return Array.from(byFiring.values());
}

/** True iff `candidate` should REPLACE `existing` as the representative
 *  row for a firing. Interceptor variant beats MISSILE_LAUNCHER; shorter
 *  asset_id breaks a variant tie. */
function preferForFiring<T extends DedupCandidate>(candidate: T, existing: T): boolean {
  const candIsInterceptor = candidate.platform_variant?.endsWith('_Interceptor') ?? false;
  const existIsInterceptor = existing.platform_variant?.endsWith('_Interceptor') ?? false;
  if (candIsInterceptor && !existIsInterceptor) return true;
  if (!candIsInterceptor && existIsInterceptor) return false;
  // Same variant class -> prefer shorter asset_id (drops the seeker
  // suffix when the two variants tie).
  return candidate.asset_id.length < existing.asset_id.length;
}

/** A munition's declared launch, read from the launch table: its launcher
 *  and the Fire it came from. No launch row means no declared launcher --
 *  both null, never recovered from the asset_id. */
export function launchFor(
  assetId: string,
  launches: ReadonlyMap<string, LaunchRef>,
): { parent_launcher_id: string | null; firing_event_urn: string | null } {
  const l = launches.get(assetId);
  return {
    parent_launcher_id: l?.launcher_asset_id ?? null,
    firing_event_urn: l?.event_urn ?? null,
  };
}
