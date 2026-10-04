// ManualQuestionPanelView is exercised with react-dom/server's
// renderToStaticMarkup, same precedent as BitDiscrepancyCard.test.tsx /
// FaultReportForm.test.tsx: no hooks in this component, no DOM dependency
// in this project (see vitest.config.ts). The stateful container
// (ManualQuestionPanel, default export) owns the fetch and is not
// exercised directly here, for the same reason FaultReportForm's isn't --
// see lib/manualQa.ts's own tests for the fetch/parsing logic this view's
// `result` prop comes from.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ManualQuestionPanelView } from '../ManualQuestionPanel';
import type { AskResult } from '../../lib/manualQa';

function baseProps(overrides: Partial<Parameters<typeof ManualQuestionPanelView>[0]> = {}) {
  return {
    platformVariant: 'MRAD_Sensor',
    scope: ['DMC-ODMRAD-A-34-10-01-00A-421A-A'],
    question: '',
    onQuestionChange: vi.fn(),
    onAsk: vi.fn(),
    asking: false,
    result: null as AskResult | null,
    stubBanner: false,
    ...overrides,
  };
}

describe('ManualQuestionPanelView — empty scope', () => {
  it('shows the no-modules-in-view message and offers no text box at all', () => {
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ scope: [], platformVariant: 'MRAD_Sensor' })} />);
    expect(html).toContain('No manual data modules in view for MRAD_Sensor');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<button');
  });

  it('falls back to a generic label when the variant is not known', () => {
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ scope: [], platformVariant: null })} />);
    expect(html).toContain('No manual data modules in view for this asset');
  });
});

describe('ManualQuestionPanelView — scope chips', () => {
  it('renders one chip per dmc in scope, labeled when a label is known', () => {
    const html = renderToStaticMarkup(
      <ManualQuestionPanelView
        {...baseProps({
          scope: ['DMC-A', 'DMC-B'],
          scopeLabels: { 'DMC-A': 'Array module fault, section 3.' },
        })}
      />,
    );
    expect(html).toContain('DMC-A — Array module fault, section 3.');
    expect(html).toContain('DMC-B');
    expect(html).not.toContain('DMC-B — ');
  });
});

describe('ManualQuestionPanelView — an answered reply with no citations is never rendered', () => {
  it('a reply {status: answered, answer: "x", citations: []} must not put "x" on the page', () => {
    const result: AskResult = { kind: 'answered', answer: 'x', citations: [] };
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ result })} />);
    expect(html).not.toContain('>x<');
    expect(html).toContain('No cited answer in the manual for this question');
  });
});

describe('ManualQuestionPanelView — an answered reply citing outside the sent scope is never rendered', () => {
  it('a citation naming a dmc this question was not scoped to is refused, even with answer text present', () => {
    const result: AskResult = {
      kind: 'answered',
      answer: 'the array module fault is section 3',
      citations: [{ dmc: 'DMC-NOT-IN-SCOPE' }],
    };
    const html = renderToStaticMarkup(
      <ManualQuestionPanelView {...baseProps({ scope: ['DMC-ODMRAD-A-34-10-01-00A-421A-A'], result })} />,
    );
    expect(html).not.toContain('the array module fault is section 3');
    expect(html).toContain('No cited answer in the manual for this question');
  });
});

describe('ManualQuestionPanelView — a well-formed, in-scope answered reply renders', () => {
  it('renders the answer text and lists each citation', () => {
    const result: AskResult = {
      kind: 'answered',
      answer: 'Reseat the connector per the fault-isolation procedure.',
      citations: [{ dmc: 'DMC-ODMRAD-A-34-10-01-00A-421A-A', step: 'Reseat connector' }],
    };
    const html = renderToStaticMarkup(
      <ManualQuestionPanelView {...baseProps({ scope: ['DMC-ODMRAD-A-34-10-01-00A-421A-A'], result })} />,
    );
    expect(html).toContain('Reseat the connector per the fault-isolation procedure.');
    expect(html).toContain('DMC-ODMRAD-A-34-10-01-00A-421A-A');
    expect(html).toContain('Reseat connector');
  });
});

describe('ManualQuestionPanelView — no_cited_answer reply', () => {
  it('shows the refusal message with its reason', () => {
    const result: AskResult = { kind: 'no_cited_answer', reason: 'no_citations' };
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ result })} />);
    expect(html).toContain('No cited answer in the manual for this question');
    expect(html).toContain('no_citations');
  });
});

describe('ManualQuestionPanelView — unavailable reply', () => {
  it('shows the service-unavailable message', () => {
    const result: AskResult = { kind: 'unavailable' };
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ result })} />);
    expect(html).toContain('Manual question service unavailable');
  });
});

describe('ManualQuestionPanelView — demo mock banner', () => {
  it('renders the banner when stubBanner is true', () => {
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ stubBanner: true })} />);
    expect(html).toContain('Demo Mock');
  });

  it('omits the banner when stubBanner is false', () => {
    const html = renderToStaticMarkup(<ManualQuestionPanelView {...baseProps({ stubBanner: false })} />);
    expect(html).not.toContain('Demo Mock');
  });
});
