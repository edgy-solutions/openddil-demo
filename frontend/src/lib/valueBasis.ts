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

// =============================================================================
// Advisory provenance — ADR-0038 C4(b)
// =============================================================================
// `recommended_action` on a CM discrepancy is an ADVISORY: a recommended
// action shown to an operator. C4(a) stamped it at the producer; this renders
// that stamp.
//
// WHY THIS NEEDS ITS OWN DECODER RATHER THAN REUSING describeBasis():
//
// Two shapes, two vocabularies. A ConstrainingFactor carries ADR-0020's
// `origin` (ORIGIN_MEASURED / ORIGIN_DERIVED) as a STRING NAME, because the
// projector decodes that topic from protobuf. A discrepancy carries `basis`
// (AdvisoryBasis) as an INTEGER, because asset-cm-state is JSON produced by
// `dataclasses.asdict` and the projector stores nested lists as JSONB
// VERBATIM — only the top-level enum columns get mapped back to names
// (ADR-0018). So the same conceptual question — "what produced this?" — needs
// a different reader per path. That asymmetry is ADR-0018's deferral showing
// up at the presentation layer, and it is the reason these maps exist.

/** AdvisoryBasis enum values, as integers on the wire. */
export const ADVISORY_BASIS_UNSPECIFIED = 0;
export const ADVISORY_BASIS_RULE = 1;
export const ADVISORY_BASIS_MODEL = 2;
export const ADVISORY_BASIS_HUMAN = 3;

const BASIS_BADGE: Record<number, string> = {
  [ADVISORY_BASIS_RULE]: 'RULE',
  [ADVISORY_BASIS_MODEL]: 'MODEL',
  [ADVISORY_BASIS_HUMAN]: 'HUMAN',
};

const BASIS_SENTENCE: Record<number, string> = {
  [ADVISORY_BASIS_RULE]:
    'Generated by a deterministic rule comparing this asset against its authorized baseline.',
  [ADVISORY_BASIS_MODEL]:
    'Generated by a statistical or ML model.',
  [ADVISORY_BASIS_HUMAN]:
    'Authored by a person, not generated by this system.',
};

/** AdvisoryLimitation values -> what the advisory explicitly does NOT claim.
 *  Rendered close to verbatim: these are the producer's own declared caveats,
 *  and paraphrasing them in the UI would let the screen drift from the
 *  contract. */
const LIMITATION_TEXT: Record<number, string> = {
  1: 'not a safety-of-use judgment',
  2: 'no claim about urgency relative to other work',
  3: 'does not check parts, tooling or personnel availability',
  4: 'not a work order — the maintenance system of record decides',
  5: 'produced from an unvalidated model',
};

export interface AdvisoryProvenance {
  basis?: number | null;
  producer?: string | null;
  producer_version?: string | null;
  config_hash?: string | null;
  model_artifact_hash?: string | null;
  rule_id?: string | null;
  inputs?: string[] | null;
  confidence?: number | null;
  confidence_kind?: number | null;
  limitations?: number[] | null;
  [key: string]: unknown;
}

/** Short badge label, or null when the advisory carries no stamp.
 *
 *  Null means NO CLAIM — never "trusted" and never "human-authored". Every
 *  discrepancy written before C4(a) lands here, which is correct: nothing is
 *  known about what produced them.
 *
 *  `typeof b !== 'number'` is deliberate rather than a truthiness check. It
 *  rejects a string enum NAME explicitly instead of relying on the lookup to
 *  miss — the same identity-not-truthiness rule the fusion guard follows,
 *  and the reason is identical: a check that happens to return the right
 *  answer for the wrong reason stops doing so the moment the lookup changes. */
export function advisoryBadge(p: AdvisoryProvenance | null | undefined): string | null {
  const b = p?.basis;
  if (typeof b !== 'number' || b === ADVISORY_BASIS_UNSPECIFIED) return null;
  return BASIS_BADGE[b] ?? null;
}

/** Full hover text, composed from what the producer stamped. Same
 *  data-driven discipline as describeBasis(): new stamp fields appear
 *  without a change here. */
export function describeAdvisory(p: AdvisoryProvenance | null | undefined): string | null {
  const badge = advisoryBadge(p);
  if (!p || !badge) return null;

  const parts: string[] = [BASIS_SENTENCE[p.basis as number] ?? ''];

  const who = [p.producer, p.producer_version].filter(Boolean).join(' ');
  if (who) parts.push(`Produced by ${who}.`);
  if (p.rule_id) parts.push(`Rule: ${p.rule_id}.`);
  if (p.config_hash) parts.push(`Baseline: ${p.config_hash}.`);
  if (p.model_artifact_hash) parts.push(`Model: ${p.model_artifact_hash}.`);
  if (p.inputs?.length) parts.push(`Read: ${p.inputs.join(', ')}.`);

  // Confidence only when a KIND is declared. An unqualified number is not
  // interpretable (ADR-0020 §Confidence staircase), and the rule-based
  // producer deliberately sets neither — so this stays silent today rather
  // than rendering "Confidence 0.00", which reads as no-confidence when the
  // truth is no-claim.
  if (typeof p.confidence === 'number' && p.confidence_kind) {
    parts.push(`Confidence ${p.confidence.toFixed(2)}.`);
  }

  const lims = (p.limitations ?? [])
    .map((l) => LIMITATION_TEXT[l])
    .filter(Boolean);
  if (lims.length) parts.push(`Does NOT claim: ${lims.join('; ')}.`);

  return parts.filter(Boolean).join(' ');
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
