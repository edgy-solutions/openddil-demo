// Same rendering strategy as EgressAdmissionPane.test.tsx: renderToStaticMarkup
// rather than @testing-library/react (not a dev dep here — see
// vitest.config.ts's comment on environment: 'node'). The fixture below is
// shaped exactly like egress/pane_api.py's `/decisions` response for the
// mmis destination (action rows carrying work_order/approval_chain beside
// the same allowed/reason/decision_id every record carries), not a hand-built
// list — this test exercises the same JSON shape the endpoint returns.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaintenanceActionsView } from '../releasability/MaintenanceActionsPane';
import type { DecisionRecord, DecisionsResponse } from '../../hooks/useEgressAdmission';

function action(
  action_id: string,
  originator_nation: string | null,
  releasable_to: string[] = [],
  allowed = true,
): DecisionRecord {
  return {
    asset_id: `${action_id}-asset`,
    originator_nation,
    releasable_to,
    allowed,
    reason: allowed ? null : originator_nation === null ? 'unlabelled' : 'no_nation_overlap',
    decision_id: `dec-${action_id}`,
    action_id,
    event_id: `${action_id}-event`,
    owning_tier: 'edge-01',
    work_order: {
      task: 'remove and replace array module at position 2',
      parts: [{ item: 'array module', part_ref: 'PN-1234', quantity: 1, source_site: 'edge-01' }],
      task_refs: [{ uri: 'graph://manual/array-module/remove-replace', dmc: 'DMC-1234-A' }],
      outcome: allowed ? 'approved' : 'rejected',
    },
    approval_chain: [
      { step: 1, role: 'maintenance_officer', approver_sub: 'approver-1', decision: 'approved', decided_at: '2026-10-02T00:00:00Z' },
      { step: 2, role: 'logistics_lead', approver_sub: 'approver-2', decision: 'approved', decided_at: '2026-10-02T00:05:00Z' },
    ],
    decided_at: '2026-10-02T00:10:00Z',
    provenance: { workflow_definition_id: 'wf-1', workflow_version: '1', instance_id: 'inst-1' },
  };
}

const FIXTURE: DecisionsResponse = {
  destination: 'system:mmis-stand-in',
  policy_version: 'policy-test',
  corpus_version: 'corpus-test',
  admitted: 2,
  refused: 1,
  records: [
    action('fixture-maint-1', 'ATL'),
    action('fixture-maint-3', 'ATL', ['BDR']),
    action('fixture-maint-4', null, [], false),
  ],
};

describe('MaintenanceActionsPane MaintenanceActionsView', () => {
  it('renders the headline as 2 of 3 admitted', () => {
    const html = renderToStaticMarkup(<MaintenanceActionsView data={FIXTURE} />);
    expect(html).toMatch(/2<\/span>[\s\S]*?of[\s\S]*?3/);
  });

  it('renders one row per action, including the task, parts and approval chain', () => {
    const html = renderToStaticMarkup(<MaintenanceActionsView data={FIXTURE} />);
    expect(html).toContain('fixture-maint-1');
    expect(html).toContain('fixture-maint-3');
    expect(html).toContain('fixture-maint-4');
    expect(html).toContain('remove and replace array module at position 2');
    expect(html).toContain('array module x1 (edge-01)');
    expect(html).toContain('maintenance_officer: approver-1 (approved)');
    expect(html).toContain('DMC-1234-A');
  });

  it('renders ADMIT for allowed rows and the refusal reason for refused rows', () => {
    const html = renderToStaticMarkup(<MaintenanceActionsView data={FIXTURE} />);
    const admitCount = html.split('ADMIT').length - 1;
    expect(admitCount).toBe(2);
    expect(html).toContain('unlabelled');
  });

  it('shows the withheld line with the same semantics as EgressAdmissionPane', () => {
    const withWithheld: DecisionsResponse = {
      ...FIXTURE,
      withheld: 4,
      viewer_nations: ['ATL'],
    };
    const html = renderToStaticMarkup(<MaintenanceActionsView data={withWithheld} />);
    expect(html).toContain('4');
    expect(html).toContain('withheld — unlabelled, so shown to no one, including fully entitled viewers');
    expect(html).toContain('viewing as ATL');
  });

  it('shows "no records visible" when records is empty', () => {
    const empty: DecisionsResponse = {
      destination: 'system:mmis-stand-in',
      policy_version: 'policy-test',
      corpus_version: 'corpus-test',
      admitted: 0,
      refused: 0,
      withheld: 4,
      viewer_nations: ['BDR'],
      records: [],
    };
    const html = renderToStaticMarkup(<MaintenanceActionsView data={empty} />);
    expect(html).toContain('No records for this destination are visible to you.');
    expect(html).toContain('4');
  });
});
