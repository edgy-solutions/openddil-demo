// =============================================================================
// assetLabel — consistent fleet-asset display labels (Phase 4c.5 fix)
// =============================================================================
// The asset_id is the guaranteed-unique identifier (it's the primary key
// of telemetry_latest_state). callsign is a secondary detail: the sim-a
// test feed reuses a single shared callsign ("IRON-LEAD") across multiple
// distinct assets, so labeling on callsign alone renders several rows
// identically and a commander cannot tell the assets apart.
//
// Every fleet list / tree / picker labels via these helpers so the
// distinguishing identifier (asset_id) is always shown.

interface LabelledAsset {
  asset_id: string;
  callsign?: string | null;
}

/** One-line label: asset_id, plus callsign appended when present AND
 *  distinct from asset_id. Some customer feeds emit the asset_id as the
 *  callsign (the upstream callsign field is unset, so the producer
 *  copies asset_id into it), which without this guard renders
 *  "X — X (variant)" in pickers. De-dupe at the label layer so every
 *  caller (Header pickerLabel, fleet trees, regional rosters, …)
 *  benefits from the same rule. */
export function assetLabel(a: LabelledAsset): string {
  const cs = a.callsign?.trim();
  return cs && cs !== a.asset_id ? `${a.asset_id} — ${cs}` : a.asset_id;
}

/** Callsign if it's a non-empty string AND distinct from asset_id,
 *  else null. Mirrors assetLabel's de-dupe rule so a secondary-line
 *  caller doesn't render the asset_id twice. */
export function assetCallsign(a: LabelledAsset): string | null {
  const cs = a.callsign?.trim();
  return cs && cs !== a.asset_id ? cs : null;
}
