// Exercised with renderToStaticMarkup for the same reason as
// EdgePulldown.test.tsx: no @testing-library/react / jsdom in this
// project's dev deps.
//
// Importing HqHeader at all pulls in '../../hooks' (useEdgeBuffer), which
// through electric.ts touches `window` at module scope -- not available
// under this project's Node (non-jsdom) vitest environment. Mocked here
// for that reason alone, same as TheaterReadinessPosture.test.tsx,
// independent of anything under test.
//
// forbidden means the PEP answered 401/403 to the WAN-control GET/POST:
// this subject does not hold the WAN-control role. The toggle must render
// disabled and explained ("WAN control: supervisor only"), and must NOT
// borrow the severed/error styling — being refused a capability is not
// the link being down.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks', () => ({
  useEdgeBuffer: () => ({ status: null, isError: false }),
}));

import HqHeader from '../HqHeader';

describe('HqHeader', () => {
  it('forbidden renders the WAN toggle disabled with "WAN control: supervisor only"', () => {
    const html = renderToStaticMarkup(
      <HqHeader wanActive={null} setWanActive={() => {}} forbidden={true} />,
    );
    expect(html).toContain('WAN control: supervisor only');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*>/);
  });

  it('not forbidden, link active -> no forbidden text, toggle not disabled', () => {
    const html = renderToStaticMarkup(
      <HqHeader wanActive={true} setWanActive={() => {}} forbidden={false} />,
    );
    expect(html).not.toContain('WAN control: supervisor only');
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*>/);
  });
});
