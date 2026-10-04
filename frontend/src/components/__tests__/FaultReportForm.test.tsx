// FaultReportFormView is exercised with react-dom/server's
// renderToStaticMarkup, same precedent as ScopeControl.test.tsx /
// EgressAdmissionPane.test.tsx: no hooks in this component, no DOM
// dependency (@testing-library/react, jsdom) in this project (see
// vitest.config.ts's comment on why environment is 'node'). The stateful
// container (FaultReportForm, default export) owns the fetch + form state
// and is not exercised directly here, for the same reason useCmState's
// Electric subscription isn't unit-tested — see lib/cmReport.ts for the
// fetch/filter logic this view's props come from.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FaultReportFormView } from '../FaultReportForm';
import type { FaultCatalog } from '../../lib/cmReport';

const MRAD_CATALOG: FaultCatalog = {
  asset_id: 'asset-1',
  platform_variant: 'MRAD_Sensor',
  manual: 'ODMRAD',
  codes: [{ code: 'MRAD-ARR-0417', text: 'Array module fault, section 3.', component: 'tr_module', severity: 'MAJOR' }],
};

function baseProps(overrides: Partial<Parameters<typeof FaultReportFormView>[0]> = {}) {
  return {
    assetId: 'asset-1',
    components: ['tr_module', 'cooling_fan'],
    catalog: MRAD_CATALOG,
    component: '',
    faultCode: '',
    description: '',
    submitting: false,
    outcome: null,
    onComponentChange: vi.fn(),
    onCodeChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe('FaultReportFormView — opens with empty fields (the plain "Report a fault" button path)', () => {
  it('renders the component and fault-code selects with no value selected', () => {
    const html = renderToStaticMarkup(<FaultReportFormView {...baseProps()} />);
    // The placeholder <option value=""> is the one marked selected; neither
    // real component nor real code option carries `selected` when both
    // fields are "".
    expect(html).toContain('<option value="" selected="">Select component…</option>');
    expect(html).toContain('<option value="" selected="">Not listed</option>');
    expect(html).not.toMatch(/<option value="tr_module" selected=""/);
    expect(html).not.toMatch(/<option value="MRAD-ARR-0417" selected=""/);
  });
});

describe('FaultReportFormView — rendered fault-code options never leak another variant\'s code', () => {
  // GV-XMSN-0201 is a GROUND_Vehicle transmission code; it must never
  // appear for an MRAD_Sensor asset. Before the asset-scoped catalog
  // (lib/cmReport.ts's loadFaultCatalog), the form had no mechanism that
  // could keep it out — see the variant regression test in
  // cmReport.test.ts.
  it('an MRAD asset\'s rendered options contain only its own catalog code', () => {
    const html = renderToStaticMarkup(<FaultReportFormView {...baseProps()} />);
    expect(html).not.toContain('GV-XMSN-0201');
    expect(html).toContain('MRAD-ARR-0417');
  });

  it('filters the fault-code options to the chosen component', () => {
    const catalog: FaultCatalog = {
      asset_id: 'asset-1',
      platform_variant: 'MRAD_Sensor',
      manual: 'ODMRAD',
      codes: [
        { code: 'FC-1', text: 'fluid leak', component: 'ENG-1', severity: 'MAJOR' },
        { code: 'FC-2', text: 'overheat', component: 'cooling_fan', severity: 'MINOR' },
      ],
    };
    const html = renderToStaticMarkup(<FaultReportFormView {...baseProps({ catalog, component: 'cooling_fan' })} />);
    expect(html).toContain('FC-2');
    expect(html).not.toContain('FC-1');
  });

  it('catalog === null (feature off / asset not visible) shows a notice, not a broken form', () => {
    const html = renderToStaticMarkup(<FaultReportFormView {...baseProps({ catalog: null })} />);
    expect(html).toContain('Fault reporting is not available for this asset.');
  });

  it('an empty catalog (no fault-isolation module) names the variant and offers only "Not listed"', () => {
    const empty: FaultCatalog = { asset_id: 'asset-2', platform_variant: 'M1A2_Tank', manual: null, codes: [] };
    const html = renderToStaticMarkup(<FaultReportFormView {...baseProps({ catalog: empty })} />);
    expect(html).toContain('No fault-isolation module for M1A2_Tank; describe the fault');
    // The fault-code <select> has exactly one option -- "Not listed" --
    // when the catalog is empty, regardless of how many components exist.
    const codeSelectHtml = html.slice(html.indexOf('Fault code'));
    expect((codeSelectHtml.match(/<option/g) ?? []).length).toBe(1);
    expect(codeSelectHtml).toContain('Not listed');
  });
});

describe('FaultReportFormView — prefill', () => {
  it('pre-selects the given component and fault code', () => {
    const html = renderToStaticMarkup(
      <FaultReportFormView {...baseProps({ component: 'tr_module', faultCode: 'MRAD-ARR-0417' })} />,
    );
    // React's SSR marks the matching <option> with a trailing selected="".
    expect(html).toMatch(/<option value="tr_module" selected="">tr_module<\/option>/);
    expect(html).toMatch(/<option value="MRAD-ARR-0417" selected="">/);
  });
});

describe('FaultReportFormView — submit gating', () => {
  it('fault_code is optional: a chosen component + description is enough to submit (button not disabled)', () => {
    const html = renderToStaticMarkup(
      <FaultReportFormView {...baseProps({ component: 'tr_module', faultCode: '', description: 'rattling noise' })} />,
    );
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*Submit report/);
  });

  it('no component chosen -> submit is disabled', () => {
    const html = renderToStaticMarkup(
      <FaultReportFormView {...baseProps({ component: '', description: 'rattling noise' })} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\s*Submit report/);
  });
});
