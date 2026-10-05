// Exercised with renderToStaticMarkup for the same reason as
// EdgePulldown.test.tsx: no @testing-library/react / jsdom in this
// project's dev deps.
//
// Importing RegionalHeader at all pulls in '../../../hooks'
// (useEdgeBuffer), which through electric.ts touches `window` at module
// scope -- not available under this project's Node (non-jsdom) vitest
// environment. Mocked here for that reason alone, same as
// HqHeader.test.tsx.
//
// The link-status label is a claim about the observed edge_buffer_status
// row (via useLinkIndicator), never about the WAN-control role. forbidden
// must add a caption beside the label, never replace the label itself —
// otherwise every non-supervisor viewer loses the honest SEVERED signal.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeBufferStatus } from '../../../hooks';

const mockUseEdgeBuffer = vi.fn();
vi.mock('../../../hooks', () => ({
  useEdgeBuffer: () => mockUseEdgeBuffer(),
}));

import RegionalHeader from '../RegionalHeader';

function setStatus(status: EdgeBufferStatus | null): void {
  mockUseEdgeBuffer.mockReturnValue({ status, isError: false });
}

const SEVERED_STATUS: EdgeBufferStatus = {
  bridge_group_lag: 0,
  hq_link_severed: true,
  probe_healthy: true,
  updated_at: new Date().toISOString(),
};

const baseProps = {
  link1: null as boolean | null,
  setLink1: () => {},
  setIsRuleEditorOpen: () => {},
};

describe('RegionalHeader', () => {
  it('forbidden + severed status: the severed label AND the caption both render', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(
      <RegionalHeader {...baseProps} forbidden={true} />,
    );
    expect(html).toContain('DDIL: LINK SEVERED');
    expect(html).toContain('WAN control: supervisor only');
  });

  it('not forbidden: no caption', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(
      <RegionalHeader {...baseProps} forbidden={false} />,
    );
    expect(html).toContain('DDIL: LINK SEVERED');
    expect(html).not.toContain('WAN control: supervisor only');
  });
});
