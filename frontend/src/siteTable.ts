// The site table: /edge-assignment/edge-assignment.yaml, every map's only
// source of FOB, region and HQ positions. Pure -- no fetch, no DOM; the
// loader in deployment.ts fetches the text and calls in here.
//
// ONE bad row invalidates the WHOLE table. A map that drew the good rows and
// silently skipped the bad one would show a confident but incomplete theater.
import { parse } from 'yaml';
import type { Fob, HqLocation, TierConfig } from './deployment';

/** A tier's own position (a region, or `hq`), as opposed to a FOB's. */
export interface TierSite { tier_id: string; lat: number; lon: number; label?: string }
export interface SiteTable { fobs: Fob[]; tierSites: TierSite[] }
export type SiteTableResult = { ok: true; table: SiteTable } | { ok: false; error: string };

export const EMPTY_SITE_TABLE: SiteTable = { fobs: [], tierSites: [] };

type Obj = Record<string, unknown>;
const isMap = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const fail = (error: string): SiteTableResult => ({ ok: false, error });

/** Validates lat/lon on a row; returns an error suffix or null. */
function checkLatLon(r: Obj): string | null {
  if (typeof r.lat !== 'number' || !Number.isFinite(r.lat)) return 'lat must be a number';
  if (r.lat < -90 || r.lat > 90) return `lat ${r.lat} is outside [-90,90]`;
  if (typeof r.lon !== 'number' || !Number.isFinite(r.lon)) return 'lon must be a number';
  if (r.lon < -180 || r.lon > 180) return `lon ${r.lon} is outside [-180,180]`;
  return null;
}

export function parseSiteTableText(text: string): SiteTableResult {
  let value: unknown;
  try {
    value = parse(text);
  } catch (e) {
    return fail(`not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseSiteTable(value);
}

export function parseSiteTable(raw: unknown): SiteTableResult {
  if (!isMap(raw)) return fail('the file is not a mapping');
  // The backends accept the same `edge_assignment:` wrapper.
  const root: Obj = isMap(raw.edge_assignment) ? raw.edge_assignment : raw;

  const steps: Obj[] = [];
  if (root.strategy === 'nearest_fob') steps.push(root);
  else if (root.strategy === 'chain' && Array.isArray(root.chain)) {
    for (const s of root.chain) if (isMap(s) && s.strategy === 'nearest_fob') steps.push(s);
  }
  if (steps.length > 1) return fail(`found ${steps.length} nearest_fob steps; at most one`);
  const hasTop = 'fobs' in root && root.strategy !== 'nearest_fob';
  if (hasTop && steps.length === 1) {
    return fail('FOB rows are in both top-level fobs and a nearest_fob step; keep one');
  }

  let fobRows: unknown[] = [];
  if (hasTop) {
    if (!Array.isArray(root.fobs)) return fail('fobs must be a list');
    fobRows = root.fobs;
  } else if (steps.length === 1) {
    const f = steps[0].fobs;
    if (!Array.isArray(f) || f.length === 0) return fail('the nearest_fob step has no fobs');
    fobRows = f;
  }

  const fobs: Fob[] = [];
  const edgeIds = new Set<string>();
  for (let i = 0; i < fobRows.length; i++) {
    const r = fobRows[i];
    if (!isMap(r)) return fail(`fobs[${i}] is not a mapping`);
    const name = nonEmpty(r.edge_id) ? ` (${r.edge_id})` : '';
    const at = `fobs[${i}]${name}`;
    if (!nonEmpty(r.edge_id)) return fail(`${at}: edge_id must be a non-empty string`);
    if (!nonEmpty(r.region_id)) return fail(`${at}: region_id must be a non-empty string`);
    const ll = checkLatLon(r);
    if (ll) return fail(`${at}: ${ll}`);
    if (r.label !== undefined && r.label !== null && typeof r.label !== 'string') {
      return fail(`${at}: label must be a string`);
    }
    if (edgeIds.has(r.edge_id)) return fail(`fobs[${i}]: duplicate edge_id ${r.edge_id}`);
    edgeIds.add(r.edge_id);
    const out: Fob = {
      edge_id: r.edge_id, region_id: r.region_id, lat: r.lat as number, lon: r.lon as number,
    };
    if (typeof r.label === 'string' && r.label.length > 0) out.label = r.label;
    fobs.push(out);
  }

  const tierSites: TierSite[] = [];
  if (root.tier_sites !== undefined && root.tier_sites !== null) {
    if (!Array.isArray(root.tier_sites)) return fail('tier_sites must be a list');
    const ids = new Set<string>();
    for (let i = 0; i < root.tier_sites.length; i++) {
      const r: unknown = root.tier_sites[i];
      if (!isMap(r)) return fail(`tier_sites[${i}] is not a mapping`);
      const name = nonEmpty(r.tier_id) ? ` (${r.tier_id})` : '';
      const at = `tier_sites[${i}]${name}`;
      if (!nonEmpty(r.tier_id)) return fail(`${at}: tier_id must be a non-empty string`);
      const ll = checkLatLon(r);
      if (ll) return fail(`${at}: ${ll}`);
      if (r.label !== undefined && r.label !== null && typeof r.label !== 'string') {
        return fail(`${at}: label must be a string`);
      }
      if (ids.has(r.tier_id)) return fail(`tier_sites[${i}]: duplicate tier_id ${r.tier_id}`);
      if (edgeIds.has(r.tier_id)) {
        return fail(`${at}: tier_id is a FOB's edge_id; an edge sits at its FOB`);
      }
      ids.add(r.tier_id);
      const out: TierSite = { tier_id: r.tier_id, lat: r.lat as number, lon: r.lon as number };
      if (typeof r.label === 'string' && r.label.length > 0) out.label = r.label;
      tierSites.push(out);
    }
  }
  return { ok: true, table: { fobs, tierSites } };
}

export interface TierSelection {
  fobs: Fob[];
  ownFob: string | null;
  tierSites: TierSite[];
  hq?: HqLocation;
}

/** Which FOBs THIS map draws: the root all; an edge every FOB in its own
 *  region; a region its own. Tier sites are never filtered. */
export function selectForTier(table: SiteTable, tier: TierConfig | undefined): TierSelection {
  const hqRow = table.tierSites.find((s) => s.tier_id === 'hq');
  const hq: HqLocation | undefined = hqRow
    ? { lat: hqRow.lat, lon: hqRow.lon, ...(hqRow.label ? { label: hqRow.label } : {}) }
    : undefined;
  const base = { tierSites: table.tierSites, hq };
  if (!tier) return { ...base, fobs: [], ownFob: null };
  if (!tier.parent) return { ...base, fobs: table.fobs, ownFob: null };
  const own = table.fobs.find((f) => f.edge_id === tier.id);
  if (own) {
    return {
      ...base,
      fobs: table.fobs.filter((f) => f.region_id === own.region_id),
      ownFob: tier.id,
    };
  }
  return { ...base, fobs: table.fobs.filter((f) => f.region_id === tier.id), ownFob: null };
}
