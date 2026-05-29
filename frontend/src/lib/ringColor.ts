// =============================================================================
// ringColor — pure severity × force-affiliation → ring hex color
// =============================================================================
// Extracted from AssetVisual.tsx so the policy table is unit-testable
// without three.js / R3F rendering. Same class of regression as the
// operationalStatePills mapping — if someone "tidies" the enum names
// (e.g. drops the duplicate-case fallthrough on CRITICAL/NON_OPERATIONAL)
// the visual contract silently shifts. Tests pin every branch.
//
// Policy (the table itself IS the contract):
//
//   forceId == FORCE_OPPOSING  → rose, regardless of severity
//   forceId == FORCE_NEUTRAL   → slate, regardless of severity
//   forceId in {FRIENDLY,unset,UNKNOWN} → severity drives color:
//      LOGISTICS_SEVERITY_OK                → emerald
//      LOGISTICS_SEVERITY_DEGRADED          → amber
//      LOGISTICS_SEVERITY_CRITICAL          → red
//      LOGISTICS_SEVERITY_NON_OPERATIONAL   → red (folded with CRITICAL)
//      anything else (UNSPECIFIED / null)   → FRIENDLY → cyan, else slate
//
// "Friendly with no severity" reading cyan (not slate) is deliberate —
// the FRIENDLY affiliation IS a positive claim about the asset; absent
// severity means "we know who they are but nothing about logistics
// state yet" which is a different shape than "no claim at all."

export type LogisticsSeverityName =
  | 'LOGISTICS_SEVERITY_UNSPECIFIED'
  | 'LOGISTICS_SEVERITY_OK'
  | 'LOGISTICS_SEVERITY_DEGRADED'
  | 'LOGISTICS_SEVERITY_CRITICAL'
  | 'LOGISTICS_SEVERITY_NON_OPERATIONAL';

export type ForceAffiliationName =
  | 'FORCE_UNSPECIFIED'
  | 'FORCE_FRIENDLY'
  | 'FORCE_OPPOSING'
  | 'FORCE_NEUTRAL'
  | 'FORCE_UNKNOWN'
  // Older naming kept tolerated downstream — caller often passes a free
  // string (e.g. from postgres .force_id column).
  | string;

// Hex colors. Exported so tests can assert against named constants
// rather than the literal strings — a refactor that swaps the literal
// keeps the contract; a refactor that swaps the SEMANTIC family fails
// the test that checks "ring is the FRIENDLY color when..."
export const COLOR_FRIENDLY = '#22d3ee'; // cyan
export const COLOR_OPPOSING = '#f43f5e'; // rose
export const COLOR_NEUTRAL  = '#94a3b8'; // slate

export const COLOR_OK       = '#10b981'; // emerald
export const COLOR_DEGRADED = '#f59e0b'; // amber
export const COLOR_CRITICAL = '#ef4444'; // red
export const COLOR_UNKNOWN  = '#64748b'; // slate-500

export function ringColor(
  severity: LogisticsSeverityName | string | null | undefined,
  forceId: ForceAffiliationName | null | undefined,
): string {
  // Force affiliation overrides severity. An enemy SHORAD reads red
  // even if its logistics severity is OK; a neutral civilian facility
  // reads slate even if degraded.
  if (forceId === 'FORCE_OPPOSING') return COLOR_OPPOSING;
  if (forceId === 'FORCE_NEUTRAL')  return COLOR_NEUTRAL;
  // Otherwise severity drives color. FRIENDLY entities use severity
  // tint; unset force_id is treated the same.
  switch (severity) {
    case 'LOGISTICS_SEVERITY_OK':              return COLOR_OK;
    case 'LOGISTICS_SEVERITY_DEGRADED':        return COLOR_DEGRADED;
    case 'LOGISTICS_SEVERITY_CRITICAL':
    case 'LOGISTICS_SEVERITY_NON_OPERATIONAL': return COLOR_CRITICAL;
    default:
      return forceId === 'FORCE_FRIENDLY' ? COLOR_FRIENDLY : COLOR_UNKNOWN;
  }
}
