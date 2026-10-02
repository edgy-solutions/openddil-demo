// ScopeControl is exercised with react-dom/server's renderToStaticMarkup
// rather than mounted with @testing-library/react: that package (and a
// DOM environment such as jsdom) isn't in this project's dev deps (see
// vitest.config.ts's own comment on why environment is 'node'). This test
// follows EgressAdmissionPane.test.tsx's precedent for that reason.
//
// "onSelect fires on change" needs no DOM at all: ScopeControl has no
// hooks/state, so calling it as a plain function returns the React
// element tree directly. We walk that tree for the <select> node and
// invoke its onChange prop by hand -- this exercises the real wiring
// (the same onChange closure the browser would call) without jsdom.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ScopeControl, { scopeMode } from '../ScopeControl';

// --- scopeMode: the count-based rule, standalone ----------------------------

describe('scopeMode', () => {
  it('more than one scope -> selector', () => {
    expect(scopeMode(['edge-01', 'edge-02'])).toBe('selector');
    expect(scopeMode(['a', 'b', 'c'])).toBe('selector');
  });

  it('exactly one scope -> label', () => {
    expect(scopeMode(['edge-01'])).toBe('label');
  });

  it('no scopes -> empty', () => {
    expect(scopeMode([])).toBe('empty');
  });
});

// --- element-tree walk for wiring tests -------------------------------------

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

// --- markup shape: selector / label / empty ---------------------------------

describe('ScopeControl markup', () => {
  it('2 scopes -> exactly one <select> with 2 <option>s', () => {
    const html = renderToStaticMarkup(
      <ScopeControl
        variant="header"
        label="EDGE"
        available={['edge-01', 'edge-02']}
        selected={null}
        onSelect={() => {}}
        emptyText="no edges observed yet"
      />,
    );
    expect((html.match(/<select/g) ?? []).length).toBe(1);
    expect((html.match(/<option/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="scope-label"');
  });

  it('1 scope -> no <select>, scope-label shows the scope even when selected differs', () => {
    const html = renderToStaticMarkup(
      <ScopeControl
        variant="header"
        label="EDGE"
        available={['edge-01']}
        selected="edge-99"
        onSelect={() => {}}
        emptyText="no edges observed yet"
      />,
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('data-testid="scope-label"');
    expect(html).toContain('>edge-01<');
  });

  it('0 scopes -> no <select>, empty text shown as a static label', () => {
    const html = renderToStaticMarkup(
      <ScopeControl
        variant="compact"
        label="Region scope"
        available={[]}
        selected={null}
        onSelect={() => {}}
        emptyText="no regions observed yet"
      />,
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('no regions observed yet');
  });
});

// --- onSelect wiring, no DOM needed ------------------------------------------

describe('ScopeControl onSelect wiring', () => {
  it('fires onSelect with the chosen value (header variant)', () => {
    const onSelect = vi.fn();
    const tree = ScopeControl({
      variant: 'header',
      label: 'EDGE',
      available: ['edge-01', 'edge-02'],
      selected: null,
      onSelect,
      emptyText: 'no edges observed yet',
    } as any);
    const select = findByType(tree, 'select');
    expect(select).toBeTruthy();
    select.props.onChange({ target: { value: 'edge-02' } });
    expect(onSelect).toHaveBeenCalledWith('edge-02');
  });

  it('fires onSelect with the chosen value (compact variant)', () => {
    const onSelect = vi.fn();
    const tree = ScopeControl({
      variant: 'compact',
      label: 'Region scope',
      available: ['region-a', 'region-b'],
      selected: 'region-a',
      onSelect,
      emptyText: 'no regions observed yet',
    } as any);
    const select = findByType(tree, 'select');
    expect(select).toBeTruthy();
    select.props.onChange({ target: { value: 'region-b' } });
    expect(onSelect).toHaveBeenCalledWith('region-b');
  });
});
