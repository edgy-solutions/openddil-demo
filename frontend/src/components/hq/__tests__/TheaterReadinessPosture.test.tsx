// FobLabel is the only per-FOB UI TheaterReadinessPosture renders, but it
// is mounted through drei's <Html> inside an R3F <Canvas>, whose scene
// graph mounts via a layout effect gated on a real DOM measurement — it
// never fires under renderToStaticMarkup (no jsdom in this project's
// vitest config). FobLabel is exported specifically so this per-FOB
// decision (the HQ-ATTACHED tag) can be render-tested directly, same
// reasoning as deployment.ts's parseTier/parseEgressPane.
//
// Importing the module at all pulls in '../../hooks', which (through
// useFleetAssets/electric.ts) touches window at module scope -- not
// available under this project's Node (non-jsdom) vitest environment.
// Mocked here for the same reason, independent of anything under test.
//
// drei's real <Html> calls useThree(), which throws ("R3F: Hooks can
// only be used within the Canvas component!") outside a mounted R3F
// Canvas -- renderToStaticMarkup never provides one. Stood up here as a
// plain passthrough so FobLabel's own markup (the thing under test) is
// reachable at all; OrbitControls/Grid are stubbed too since they share
// the module but are never rendered by FobLabel itself.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: [], isLoading: false, isError: false }),
  useAllLogisticsStatus: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../../deployment', () => ({
  deployment: () => ({ fobs: [] }),
  edgeAttachment: () => undefined,
}));
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  OrbitControls: () => null,
  Grid: () => null,
}));

import { FobLabel } from '../TheaterReadinessPosture';

const composition = { sensors: 1, launchers: 0, facilities: 0, inflight: 0, other: 0 };

describe('FobLabel — HQ-ATTACHED tag', () => {
  it('shows the tag and the tooltip text when attachment is hq', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-03"
        total={1}
        composition={composition}
        attachment="hq"
      />
    );
    expect(html).toContain('HQ-ATTACHED');
    expect(html).toContain('Writes straight to HQ. No edge store: this is not edge data that survives a WAN cut.');
  });

  it('does not show the tag when attachment is tier', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-01"
        total={1}
        composition={composition}
        attachment="tier"
      />
    );
    expect(html).not.toContain('HQ-ATTACHED');
  });

  it('does not show the tag when attachment is undeclared (undefined)', () => {
    const html = renderToStaticMarkup(
      <FobLabel
        position={[0, 0, 0]}
        label="edge-02"
        total={1}
        composition={composition}
      />
    );
    expect(html).not.toContain('HQ-ATTACHED');
  });
});

describe('FobLabel — link state word', () => {
  const words: Array<[any, string]> = [
    [{ state: 'up', declaredIdle: false }, 'UP'],
    [{ state: 'idle', declaredIdle: false }, 'IDLE'],
    [{ state: 'idle', declaredIdle: true }, 'IDLE · declared'],
    [{ state: 'down', declaredIdle: false }, 'DOWN'],
    [{ state: 'unknown', declaredIdle: false }, 'UNKNOWN'],
  ];
  it.each(words)('renders %j as %s', (link, word) => {
    const html = renderToStaticMarkup(
      <FobLabel position={[0, 0, 0]} label="edge-01" total={1} composition={composition} link={link} />
    );
    expect(html).toContain(`data-link-state="${word}"`);
  });
});
