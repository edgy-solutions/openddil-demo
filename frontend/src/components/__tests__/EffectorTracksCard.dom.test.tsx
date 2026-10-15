// @vitest-environment jsdom
// In flight on the card is the number of in-flight munition_track rows passed
// in (ADR-0049), whatever effector_launch terminal_state says.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import EffectorTracksCard from '../EffectorTracksCard';
import type { EffectorLaunch } from '../../hooks';

function launch(n: number, terminalState: string | null): EffectorLaunch {
  return {
    eventUrn: `dis-event:1:1:${n}`,
    munitionType: '2.1.225.1.0.0.0',
    quantity: 1,
    targetAssetId: null,
    launchedAt: `2026-10-06T12:00:0${n}Z`,
    terminalState,
    detonationResult: null,
    terminatedAt: null,
    lateTerminal: false,
  };
}

// Three launches with no terminal state: the old reading would say 3.
const LAUNCHES = [launch(1, null), launch(2, null), launch(3, null), launch(4, 'detonated')];

function inFlightText(container: HTMLElement): string | null {
  const span = [...container.querySelectorAll('span')].find((s) => s.textContent?.startsWith('In flight'));
  return span?.querySelector('span')?.textContent ?? null;
}

describe('EffectorTracksCard in flight', () => {
  afterEach(cleanup);

  it('equals the track count passed in', () => {
    const { container } = render(<EffectorTracksCard launches={LAUNCHES} inFlightCount={2} />);
    expect(inFlightText(container)).toBe('2');
  });

  it('is zero with no tracks even when launches have no terminal state', () => {
    const { container } = render(<EffectorTracksCard launches={LAUNCHES} inFlightCount={0} />);
    expect(inFlightText(container)).toBe('0');
  });
});
