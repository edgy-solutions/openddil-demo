// =============================================================================
// coLocationLayout — same-point bucketing for the Regional map
// =============================================================================
// Assets whose projected positions round to the same COLOC_BUCKET cell
// are one cluster on the Regional map (when they carry no edge_id).
// Every asset is drawn at its true position; clusterKinds decides how a
// cluster is drawn while its members are too close to tell apart.

export const COLOC_BUCKET = 0.5;

/** Bucket-key generator. Rounds (x, z) to the COLOC_BUCKET grid so
 *  positions within `COLOC_BUCKET` units of each other land in the
 *  same bucket. Order: x first, then z, separated by '|'. */
export function colocationBucketKey(x: number, z: number): string {
  return `${Math.round(x / COLOC_BUCKET)}|${Math.round(z / COLOC_BUCKET)}`;
}
