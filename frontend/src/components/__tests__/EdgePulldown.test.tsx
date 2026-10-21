// Exercised with renderToStaticMarkup for the same reason as
// ScopeControl.test.tsx and EgressAdmissionPane.test.tsx: no
// @testing-library/react / jsdom in this project's dev deps.
//
// RED/green history: against the pre-Spec-C EdgePulldown.tsx (a disabled
// <select> for the single-edge case), this test fails -- confirmed by
// running it against a `git show HEAD:...` copy of the old file before
// this change landed. It passes against the ScopeControl-backed rewrite,
// which renders a plain label instead of a disabled control.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EdgePulldown from '../EdgePulldown';
import { edgeLabel } from '../../lib/edgeLabel';

describe('edgeLabel', () => {
  const fobs = [{ edge_id: 'edge-01', label: 'FOB ALPHA' }, { edge_id: 'edge-02' }];
  it('labelled fob -> "name · id"', () => {
    expect(edgeLabel('edge-01', fobs)).toBe('FOB ALPHA · edge-01');
  });
  it('unlabelled or unknown edge -> bare id', () => {
    expect(edgeLabel('edge-02', fobs)).toBe('edge-02');
    expect(edgeLabel('edge-09', fobs)).toBe('edge-09');
  });
});

describe('EdgePulldown', () => {
  it('1 edge observed -> no <select>, labels the one edge', () => {
    const html = renderToStaticMarkup(
      <EdgePulldown available={['edge-01']} selected={null} onSelect={() => {}} />,
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('data-testid="scope-label"');
    expect(html).toContain('>edge-01<');
  });
});
