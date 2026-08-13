// =============================================================================
// valueBasis — render a value's basis from its provenance, not from a
// per-field condition
// =============================================================================
// ADR-0035 class 1 (modelled-not-measured) for values that arrive with a
// provenance stamp. ADR-0035 IH-6.
//
// WHY THIS IS DATA-DRIVEN RATHER THAN A HARDCODED BADGE:
//
// The pre-IH-6 alternative was `if (field === 'projected_mission_capable')
// showBadge()`. That works exactly once. Every later derived value needs its
// own condition, the conditions drift from what the producer actually stamps,
// and a value whose origin CHANGES (a projection that becomes validated, or
// an ML unit replacing a rule) keeps whatever badge someone hardcoded for it.
//
// So the badge is keyed off `origin`, and the hover text is COMPOSED FROM
// WHATEVER PROVENANCE FIELDS ARE PRESENT. When ADR-0034's analytics units
// start stamping `detector` / `version` / `config_hash` /
// `model_artifact_hash`, and when the uncertainty band ADR-0038 AE-4 names
// lands, those appear in the tooltip WITHOUT A FRONTEND CHANGE — they only
// have to appear in the JSON. Adding a field to the wire is the whole
// integration.
//
// The one thing that never changes is the badge's PRESENCE for a derived
// value. See the note on permanence at the bottom of this file.

/** Anything carrying an ADR-0020 `Origin` stamp. Deliberately loose: this
 *  reads provenance opportunistically so new stamp fields need no type
 *  churn here. */
export interface ProvenanceBearing {
  origin?: string | null;
  confidence?: number | null;
  factor_id?: string | null;
  /** Forward-looking: ADR-0034 analytics stamps + any future interval.
   *  Unknown keys are surfaced generically by describeBasis(). */
  [key: string]: unknown;
}

export type BasisKind = 'MEASURED' | 'DERIVED' | 'UNKNOWN';

export function basisKind(p: ProvenanceBearing | null | undefined): BasisKind {
  switch (p?.origin) {
    case 'ORIGIN_MEASURED': return 'MEASURED';
    case 'ORIGIN_DERIVED':  return 'DERIVED';
    default:                return 'UNKNOWN';
  }
}

// Provenance keys rendered in a fixed, readable order when present. Anything
// stamped but not listed here still reaches the tooltip via the generic pass
// below — the list is for ordering the ones we know, not for gating.
const KNOWN_ORDER = [
  'detector', 'version', 'config_hash', 'model_artifact_hash',
  'interval', 'window', 'tier',
] as const;

const SKIP = new Set([
  'origin', 'confidence', 'factor_id', 'severity', 'description',
  'current_value', 'threshold', 'projected_time_to_worse',
]);

function labelFor(key: string): string {
  return key.replace(/_/g, ' ');
}

/** Human-readable basis sentence, composed from what the producer stamped.
 *  Returns null when there is nothing honest to say (no stamp at all) — the
 *  caller renders no badge in that case rather than inventing one. */
export function describeBasis(p: ProvenanceBearing | null | undefined): string | null {
  const kind = basisKind(p);
  if (!p || kind === 'UNKNOWN') return null;

  const parts: string[] = [];

  parts.push(
    kind === 'DERIVED'
      ? 'Derived value — computed by this system from other inputs, not measured by a sensor or reported by a feed.'
      : 'Measured value — reported by a feed rather than computed here.',
  );

  if (typeof p.confidence === 'number') {
    // Confidence is meaningless without its kind (ADR-0020 §Confidence
    // staircase). Until a declared kind rides alongside it, say plainly
    // that today's value is asserted rather than computed — an unqualified
    // "confidence 0.2" reads as a measurement of trust and is not one.
    parts.push(
      `Confidence ${p.confidence.toFixed(2)} — asserted, not computed ` +
      `(no fit-quality estimate is available for this value today).`,
    );
  }

  const extras: string[] = [];
  for (const key of KNOWN_ORDER) {
    const v = p[key];
    if (v !== undefined && v !== null && v !== '') {
      extras.push(`${labelFor(key)}: ${String(v)}`);
    }
  }
  // Generic pass — anything else the producer stamped that we do not yet
  // have an opinion about. This is what makes new stamp fields visible
  // without a frontend change.
  for (const [key, v] of Object.entries(p)) {
    if (SKIP.has(key) || (KNOWN_ORDER as readonly string[]).includes(key)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') continue;  // nested shapes need their own render
    extras.push(`${labelFor(key)}: ${String(v)}`);
  }
  if (extras.length) parts.push(extras.join(' · '));

  return parts.join(' ');
}

// -----------------------------------------------------------------------------
// On permanence — recorded here because it will be asked again
// -----------------------------------------------------------------------------
// THE DERIVED MARKER IS NOT A SIMULATION ARTIFACT AND DOES NOT COME OFF WHEN
// REAL DATA ARRIVES.
//
// A remaining-life horizon is modelled BY CONSTRUCTION. Nobody measures "37
// hours until limit" — it is a projection under assumptions, and better
// telemetry improves the projection's INPUTS, never changes the output's
// nature. A validated Weibull fit on real failure history is still a model.
//
// What evolves is the marker's CONTENT, which is why the tooltip is composed
// from provenance rather than written as a sentence:
//
//   today  "Derived value … Confidence 0.20 — asserted, not computed"
//   later  "Derived value … model: weibull-v3.2 · interval: ±6h @80%"
//
// The presence of the marker is invariant. Removing it once numbers look
// trustworthy would be presenting a projection as a measurement — the
// decision-assertion hazard ADR-0038 §2 fences against, and the reason that
// boundary is stated as an architectural limit rather than a maturity stage.
