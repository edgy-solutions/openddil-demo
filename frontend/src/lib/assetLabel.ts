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

/** One-line label: asset_id, plus callsign appended when present. */
export function assetLabel(a: LabelledAsset): string {
  const cs = a.callsign?.trim();
  return cs ? `${a.asset_id} — ${cs}` : a.asset_id;
}

/** Callsign if it's a non-empty string, else null — for a secondary line. */
export function assetCallsign(a: LabelledAsset): string | null {
  const cs = a.callsign?.trim();
  return cs ? cs : null;
}
