// =============================================================================
// sources -- the fetch for GET /cm/sources?asset_id=<id> (ADR-0053 first slice)
// =============================================================================
// Types mirror gateway/pep.py's _handle_cm_sources exactly. Three sources,
// each with its own band. There is deliberately no field and no function
// here that takes more than one band.
export type Band = 'ready' | 'limited' | 'not-ready';
export type SourceName = 'observed' | 'declared' | 'derived';

export interface Discrepancy {
  fault_code: string | null;
  component: string | null;
  description: string | null;
  severity: string | null;
}

export interface ObservedRecord {
  operational_status: string | null;
  health_state: string | null;
  reporting_status: string | null;
  last_sample_at: string | null;
}

export interface DeclaredRecord {
  overall_status: string | null;
  lifecycle: string | null;
  baseline_id: string | null;
  as_of: string | null;
  manual_discrepancies: Discrepancy[];
  declaration: { declared_by: string | null; declared_at: string | null } | null;
}

export interface DerivedRecord {
  overall_severity: string | null;
  constraining_factors: unknown[];
}

export interface SourceCell<R> {
  record: R | null;
  band: Band | null;
  tier: string | null;
  source: string | null;
  time: string | null;
}

export interface SourcesBody {
  asset_id: string;
  platform_variant: string | null;
  served_at: string;
  sources: {
    observed: SourceCell<ObservedRecord> & { silent: boolean };
    declared: SourceCell<DeclaredRecord>;
    derived: SourceCell<DerivedRecord>;
  };
}

/** null when the route is off, there is no session, or the asset is not
 *  visible here -- the caller shows "no sources" rather than an error. */
export async function loadSources(
  assetId: string,
  fetchFn: typeof fetch = fetch,
): Promise<SourcesBody | null> {
  let res: Response;
  try {
    res = await fetchFn(`/cm/sources?asset_id=${encodeURIComponent(assetId)}`, {
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as SourcesBody;
    return body && body.sources ? body : null;
  } catch {
    return null;
  }
}
