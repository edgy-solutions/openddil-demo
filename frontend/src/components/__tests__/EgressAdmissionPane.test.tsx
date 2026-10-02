// DecisionsView is exercised with react-dom/server's renderToStaticMarkup
// rather than mounted with @testing-library/react: that package (and jsdom)
// isn't in this project's dev deps (see vitest.config.ts's own comment on
// why environment is 'node'), and renderToStaticMarkup is a real React
// render that needs neither — it runs the same reconciliation a mount would,
// serialized to a string instead of attached to a document.
//
// The fixture below is shaped exactly like `egress/pane_api.py`'s
// `/decisions` response (see its module docstring and the spec's acceptance
// checks) — not a hand-built list of nations — so this test exercises the
// same JSON shape the endpoint actually returns.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionsView } from '../releasability/EgressAdmissionPane';
import type { DecisionRecord, DecisionsResponse } from '../../hooks/useEgressAdmission';

function admit(asset_id: string, releasable_to: string[] = []): DecisionRecord {
  return {
    asset_id,
    originator_nation: 'ATL',
    releasable_to,
    allowed: true,
    reason: null,
    decision_id: `dec-${asset_id}`,
  };
}

function refuseNoOverlap(asset_id: string): DecisionRecord {
  return {
    asset_id,
    originator_nation: 'BDR',
    releasable_to: [],
    allowed: false,
    reason: 'no_nation_overlap',
    decision_id: `dec-${asset_id}`,
  };
}

// An UNLABELLED refusal: a record that reached the boundary carrying no
// originator at all. Measured on the compose stack, this is the gate's
// dominant refusal — 4533 of 4594 — so a fixture without it would leave the
// most common thing this pane has to say completely untested.
function refuseUnlabelled(asset_id: string): DecisionRecord {
  return {
    asset_id,
    originator_nation: null,
    releasable_to: [],
    allowed: false,
    reason: 'unlabelled',
    decision_id: `dec-${asset_id}`,
  };
}

// The gate's WHOLE record set, not the declared fleet: 7 pure-ATL admits, the
// one ATL/{BDR} admit (the 8th, not a 9th), 6 BDR `no_nation_overlap`
// refusals, and the 15 unlabelled records that are also on the wire. The
// endpoint decides every key it finds, so 29 records is the shape it returns
// — see pane_api.py's "WHY THE RECORD SET IS NOT FILTERED" section.
const FIXTURE: DecisionsResponse = {
  destination: 'system:c2-stand-in-atl',
  policy_version: 'policy-test',
  corpus_version: 'corpus-test',
  admitted: 8,
  refused: 21,
  records: [
    ...Array.from({ length: 7 }, (_, i) => admit(`dis:1:1:100${i}`)),
    admit('dis:1:1:1000', ['BDR']),
    ...Array.from({ length: 6 }, (_, i) => refuseNoOverlap(`dis:2:1:100${i}`)),
    ...Array.from({ length: 15 }, (_, i) => refuseUnlabelled(`dis:1:1:9${i}`)),
  ],
};

describe('EgressAdmissionPane DecisionsView', () => {
  it('renders the headline as 8 of 29 — the whole record set, not the labelled part', () => {
    const html = renderToStaticMarkup(<DecisionsView data={FIXTURE} />);
    expect(html).toContain('8');
    expect(html).toContain('29');
    expect(html).toMatch(/8<\/span>[\s\S]*?of[\s\S]*?29/);
  });

  // The failure this guards against is the one that shipped first: an
  // unlabelled record dropped from the record set renders as absence, so an
  // asset carrying no releasability label and an asset that does not exist
  // read identically. ADR-0044 rules out exactly this shape for lifecycle
  // ("if a quiet asset and a destroyed asset ever render alike, this
  // failed"); it is no more acceptable here.
  it('renders every unlabelled refusal as a refusal, never as absence', () => {
    const html = renderToStaticMarkup(<DecisionsView data={FIXTURE} />);
    const occurrences = html.split('unlabelled').length - 1;
    // One occurrence in the tally line plus one per refused row.
    expect(occurrences).toBe(16);
  });

  // `unlabelled` outnumbers `no_nation_overlap` 15 to 6, and tallyRefusals
  // sorts by count, so the dominant refusal must lead. A pane that buries the
  // most common reason behind a rarer one is answering a different question.
  it('orders the refusal tally by count, dominant reason first', () => {
    const html = renderToStaticMarkup(<DecisionsView data={FIXTURE} />);
    expect(html.indexOf('unlabelled')).toBeLessThan(html.indexOf('no_nation_overlap'));
  });

  it('shows all six no_nation_overlap rows, not a collapsed total', () => {
    const html = renderToStaticMarkup(<DecisionsView data={FIXTURE} />);
    const occurrences = html.split('no_nation_overlap').length - 1;
    // One occurrence in the tally line plus one per refused row.
    expect(occurrences).toBe(7);
  });

  it('renders ADMIT for allowed records without ever branching on nation', () => {
    const html = renderToStaticMarkup(<DecisionsView data={FIXTURE} />);
    const admitCount = html.split('ADMIT').length - 1;
    expect(admitCount).toBe(8);
  });
});

// =============================================================================
// PA: the egress pane behind the PEP — withheld/viewer_nations rendering
// =============================================================================
// Shaped like the PEP's filtered response (gateway/egress_view.py), not the
// compose pane's own answer: `withheld` and `viewer_nations` are the two
// fields the PEP adds, and they are optional on DecisionsResponse precisely
// because compose's direct, unfiltered pane sends neither.
describe('EgressAdmissionPane DecisionsView — withheld (PA)', () => {
  const PARTIALLY_WITHHELD: DecisionsResponse = {
    destination: 'system:c2-stand-in-atl',
    policy_version: 'policy-test',
    corpus_version: 'corpus-test',
    admitted: 1,
    refused: 0,
    withheld: 2,
    viewer_nations: ['ATL'],
    records: [admit('dis:1:1:1000')],
  };

  it('renders the withheld line with the count and viewer nations', () => {
    const html = renderToStaticMarkup(<DecisionsView data={PARTIALLY_WITHHELD} />);
    expect(html).toContain('withheld');
    expect(html).toContain('2');
    expect(html).toContain('ATL');
    expect(html).toMatch(/2<\/span>[\s\S]*?withheld/);
  });

  const ALL_WITHHELD: DecisionsResponse = {
    destination: 'system:c2-stand-in-atl',
    policy_version: 'policy-test',
    corpus_version: 'corpus-test',
    admitted: 0,
    refused: 0,
    withheld: 15,
    viewer_nations: ['BDR'],
    records: [],
  };

  it('renders the all-withheld sentence, never "No records", when every record is withheld (ADR-0035)', () => {
    const html = renderToStaticMarkup(<DecisionsView data={ALL_WITHHELD} />);
    expect(html).toContain('All');
    expect(html).toContain('15');
    expect(html).toContain('withheld from your view');
    expect(html).not.toContain('No records for this destination.');
  });

  const NO_WITHHELD_FIELD: DecisionsResponse = {
    destination: 'system:c2-stand-in-atl',
    policy_version: 'policy-test',
    corpus_version: 'corpus-test',
    admitted: 8,
    refused: 21,
    records: FIXTURE.records,
    // withheld/viewer_nations intentionally absent — compose's direct pane.
  };

  it('renders exactly as before when withheld is absent (compose, unfiltered pane)', () => {
    const html = renderToStaticMarkup(<DecisionsView data={NO_WITHHELD_FIELD} />);
    expect(html).not.toContain('withheld');
    expect(html).toMatch(/8<\/span>[\s\S]*?of[\s\S]*?29/);
  });
});
