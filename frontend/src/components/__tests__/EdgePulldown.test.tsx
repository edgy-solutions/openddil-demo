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
