// BitDiscrepancyCard has no hooks -- same renderToStaticMarkup precedent as
// FaultReportFormView/ScopeControl (see those tests' header comments for
// why: no DOM deps in this project).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BitDiscrepancyCard from '../BitDiscrepancyCard';

describe('BitDiscrepancyCard', () => {
  it('shows the card text and a "Record it" button when not yet recorded', () => {
    const html = renderToStaticMarkup(
      <BitDiscrepancyCard
        text="Fault detected on tr_module: Array module fault, section 3. (MRAD-ARR-0417), 14:32Z. Record it?"
        recorded={false}
        onRecord={vi.fn()}
      />,
    );
    expect(html).toContain('Fault detected on tr_module');
    expect(html).toContain('Record it');
    expect(html).not.toContain('Recorded, awaiting confirmation');
  });

  it('shows "Recorded, awaiting confirmation" instead of the button once recorded', () => {
    const html = renderToStaticMarkup(
      <BitDiscrepancyCard
        text="Fault detected on tr_module: MRAD-ARR-0417 (MRAD-ARR-0417), 14:32Z. Record it?"
        recorded={true}
        onRecord={vi.fn()}
      />,
    );
    expect(html).toContain('Recorded, awaiting confirmation');
    expect(html).not.toMatch(/<button[^>]*>\s*Record it/);
  });

  it('the Record it button calls onRecord when clicked', () => {
    const onRecord = vi.fn();
    const tree = BitDiscrepancyCard({ text: 'x', recorded: false, onRecord } as any);
    function findByType(node: any, type: string): any {
      if (!node || typeof node !== 'object') return null;
      if (node.type === type) return node;
      const children = node.props?.children;
      if (Array.isArray(children)) {
        for (const c of children) {
          const found = findByType(c, type);
          if (found) return found;
        }
      } else if (children) {
        return findByType(children, type);
      }
      return null;
    }
    const button = findByType(tree, 'button');
    expect(button).toBeTruthy();
    button.props.onClick();
    expect(onRecord).toHaveBeenCalledTimes(1);
  });
});
