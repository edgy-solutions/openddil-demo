// =============================================================================
// munitionType -- extract the munition-type token from a capability_id
// =============================================================================
// The customer's weapons-capability wire shape carries a
// `capability_id` per store that concatenates two pieces: the
// launcher's asset_id and the munition-type token, joined by an
// underscore. For example, a launcher with asset_id `<LAUNCHER_ID>`
// and a capability carrying `<LAUNCHER_ID>_<MUNITION_TYPE>_Interceptor`
// yields a munition_type of `<MUNITION_TYPE>_Interceptor`.
//
// This is a generic prefix-strip -- works for any producer whose
// weapons-capability feed follows the `<launcher>_<munition-type>`
// naming convention. Fallback returns the raw capability_id
// unchanged so producers that don't follow the pattern still render
// something meaningful (the label just isn't type-collapsed for
// aggregation).
//
// Not customer-identifying: this function contains no knowledge of
// specific launcher names, deployment locations, or munition
// vocabulary. Concrete observed values live in the private overlay.
// =============================================================================

/**
 * Return the munition-type portion of a capability_id, assuming the
 * `<launcher_asset_id>_<munition_type>` convention. If the capability_id
 * does not start with the launcher's asset_id + '_', returns the raw
 * capability_id unchanged (producer-doesn't-follow-convention path).
 */
export function extractMunitionType(
  capabilityId: string,
  launcherAssetId: string,
): string {
  if (!capabilityId) return '';
  const prefix = launcherAssetId + '_';
  if (capabilityId.startsWith(prefix)) {
    return capabilityId.substring(prefix.length);
  }
  return capabilityId;
}

/** Short human-facing form of a munition_type -- collapses long
 *  auto-generated suffixes to something readable on a badge.
 *  Currently just returns as-is; kept as a seam for future
 *  ORBAT-aware display rules without touching call sites. */
export function displayMunitionType(munitionType: string): string {
  return munitionType || '(unspecified)';
}
