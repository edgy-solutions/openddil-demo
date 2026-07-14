// =============================================================================
// munitionAsset -- helpers for the in-flight MUNITION-class row family
// =============================================================================
// When a launcher fires, the producer emits two entity rows per firing --
// one for the delivery vehicle (matches the *_Interceptor variant of the
// launcher's magazine), and one for the seeker payload (matches
// MISSILE_LAUNCHER variant with a distinguishing suffix). Both carry the
// same firing sequence and reference the same parent launcher through
// their asset_id.
//
// Canonical shape of an in-flight munition asset_id:
//
//   prop:<MUNITION_TYPE>_<SEQ>-<PARENT_LAUNCHER_ID>[_<seeker-suffix>]
//
// Examples (structure-only, no customer strings):
//
//   prop:<TYPE>_10-<LAUNCHER>
//   prop:<TYPE>_10-<LAUNCHER>_<seeker-suffix>
//
// Both rows for a single firing share (parent_launcher, seq); dedup on
// that tuple gives one row per firing.
//
// Parent-launcher discovery: rather than parsing the "-<parent>[_<suffix>]"
// tail with a regex (fragile if the seeker suffix is ambiguous), we take
// the SET of known launcher asset_ids (everything in asset_capability_state)
// and search for whichever known launcher appears as a "-<launcher>"
// substring in the munition's asset_id. If more than one launcher's id
// is a substring, prefer the LONGEST match (a producer whose naming
// happens to nest one launcher's id inside another still resolves to
// the right parent).
//
// This is entirely generic across producers: any wire that follows the
// "in-flight asset_id embeds the launcher's asset_id" convention works
// without customizing this file. Producers that use a different linkage
// mechanism (e.g., a `parent_launcher_id` field on the entity message)
// would land in the OpenDDIL canonical shape via their Bloblang layer,
// stamping the field at ingest time -- the frontend then reads that
// field directly and skips this fallback pathway.
// =============================================================================

/**
 * Try to extract the parent launcher asset_id from an in-flight
 * munition's asset_id, using the set of known launcher asset_ids
 * (typically derived from asset_capability_state).
 *
 * Returns the matched launcher asset_id, or null if no match.
 */
export function extractParentLauncherFromAssetId(
  munitionAssetId: string,
  launcherAssetIds: ReadonlySet<string>,
): string | null {
  let best: string | null = null;
  for (const launcherId of launcherAssetIds) {
    // Anchor the check on `-<launcher>` so we don't false-match on a
    // launcher whose id happens to be a prefix of another string in the
    // munition's asset_id. The dash prefix is the reliable separator in
    // the observed naming pattern.
    if (munitionAssetId.includes('-' + launcherId)) {
      if (best === null || launcherId.length > best.length) {
        best = launcherId;
      }
    }
  }
  return best;
}

/**
 * Extract the firing-sequence integer from a munition asset_id.
 * Returns the sequence value, or null if the pattern doesn't match.
 *
 * Rule: an underscore-separated numeric segment immediately preceding
 * the first '-'. The segment must be pure digits.
 */
export function extractFiringSequence(assetId: string): number | null {
  // Take everything before the first '-'.
  const dashIdx = assetId.indexOf('-');
  if (dashIdx < 0) return null;
  const beforeDash = assetId.substring(0, dashIdx);
  // The sequence is the trailing underscore-delimited segment.
  const underscoreIdx = beforeDash.lastIndexOf('_');
  if (underscoreIdx < 0) return null;
  const tail = beforeDash.substring(underscoreIdx + 1);
  if (!/^\d+$/.test(tail)) return null;
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

/**
 * A stable identity for a firing = (parent_launcher, sequence). Both
 * rows for the same firing (delivery vehicle + seeker payload) share
 * this identity; dedup by this key.
 *
 * When either component is unknown, falls back to the asset_id itself
 * so we still count the row rather than dropping it silently.
 */
export function firingIdentity(
  assetId: string,
  parentLauncherId: string | null,
  sequence: number | null,
): string {
  if (parentLauncherId !== null && sequence !== null) {
    return `${parentLauncherId}#${sequence}`;
  }
  return `raw:${assetId}`;
}

/**
 * Given a list of MUNITION-class rows carrying (parent_launcher,
 * sequence, platform_variant), return one representative row per
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
  firing_sequence: number | null;
}

export function dedupFirings<T extends DedupCandidate>(rows: T[]): T[] {
  const byFiring = new Map<string, T>();
  for (const r of rows) {
    const key = firingIdentity(r.asset_id, r.parent_launcher_id, r.firing_sequence);
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
