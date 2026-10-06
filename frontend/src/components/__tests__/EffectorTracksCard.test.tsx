// EffectorTracksCard -- renderToStaticMarkup precedent (see
// BitDiscrepancyCard.test.tsx's header comment for why: no DOM deps in
// this project).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EffectorTracksCard, { effectorCounts, outcomeLabel } from '../EffectorTracksCard';
import type { EffectorLaunch } from '../../hooks';

function launch(overrides: Partial<EffectorLaunch>): EffectorLaunch {
  return {
    eventUrn: 'dis-event:1:1:0',
    munitionType: '2.1.1.2.3.1.0',
    quantity: 1,
    targetAssetId: null,
    launchedAt: '2026-10-06T12:00:00Z',
    terminalState: null,
    detonationResult: null,
    terminatedAt: null,
    lateTerminal: false,
    ...overrides,
  };
}

// q1 each: 2 in flight, 1 unresolved, 1 entity_impact, 1 dud, 1 late
// entity_impact -> expended 6, in flight 2, unresolved 1.
const sixRowFixture: EffectorLaunch[] = [
  launch({ eventUrn: 'dis-event:1:1:1', terminalState: null, launchedAt: '2026-10-06T12:00:01Z' }),
  launch({ eventUrn: 'dis-event:1:1:2', terminalState: null, launchedAt: '2026-10-06T12:00:02Z' }),
  launch({ eventUrn: 'dis-event:1:1:3', terminalState: 'unresolved', launchedAt: '2026-10-06T12:00:03Z' }),
  launch({ eventUrn: 'dis-event:1:1:4', terminalState: 'entity_impact', launchedAt: '2026-10-06T12:00:04Z' }),
  launch({ eventUrn: 'dis-event:1:1:5', terminalState: 'dud', launchedAt: '2026-10-06T12:00:05Z' }),
  launch({
    eventUrn: 'dis-event:1:1:6',
    terminalState: 'entity_impact',
    lateTerminal: true,
    launchedAt: '2026-10-06T12:00:06Z',
  }),
];

describe('effectorCounts', () => {
  it('computes expended / in flight / unresolved over the six-row fixture', () => {
    expect(effectorCounts(sixRowFixture)).toEqual({ expended: 6, inFlight: 2, unresolved: 1 });
  });
});

describe('outcomeLabel', () => {
  it('labels every terminal state, never "miss" or "hit"', () => {
    expect(outcomeLabel(null)).toBe('in flight');
    expect(outcomeLabel('entity_impact')).toBe('entity impact');
    expect(outcomeLabel('ground_impact')).toBe('ground impact');
    expect(outcomeLabel('detonated')).toBe('detonated');
    expect(outcomeLabel('dud')).toBe('dud');
    expect(outcomeLabel('other')).toBe('other');
    expect(outcomeLabel('unresolved')).toBe('unresolved (no termination seen)');

    const allLabels = [
      outcomeLabel(null),
      outcomeLabel('entity_impact'),
      outcomeLabel('ground_impact'),
      outcomeLabel('detonated'),
      outcomeLabel('dud'),
      outcomeLabel('other'),
      outcomeLabel('unresolved'),
    ].join(' ');
    expect(allLabels).not.toMatch(/\bmiss\b|\bhit\b/i);
  });
});

describe('EffectorTracksCard', () => {
  it('renders nothing when there are no rows', () => {
    const html = renderToStaticMarkup(<EffectorTracksCard launches={[]} />);
    expect(html).toBe('');
  });

  it('shows the header counts from the six-row fixture', () => {
    const html = renderToStaticMarkup(<EffectorTracksCard launches={sixRowFixture} />);
    expect(html).toContain('Effector Tracks');
    // expended 6, in flight 2, unresolved 1 -- each adjacent to its label.
    expect(html).toMatch(/Expended[^<]*<[^>]*>6/);
    expect(html).toMatch(/In flight[^<]*<[^>]*>2/);
    expect(html).toMatch(/Unresolved[^<]*<[^>]*>1/);
  });

  it('renders every outcome label and never "miss" or "hit"', () => {
    const allOutcomes: EffectorLaunch[] = [
      launch({ eventUrn: 'dis-event:2:1:1', terminalState: null }),
      launch({ eventUrn: 'dis-event:2:1:2', terminalState: 'entity_impact' }),
      launch({ eventUrn: 'dis-event:2:1:3', terminalState: 'ground_impact' }),
      launch({ eventUrn: 'dis-event:2:1:4', terminalState: 'detonated' }),
      launch({ eventUrn: 'dis-event:2:1:5', terminalState: 'dud' }),
      launch({ eventUrn: 'dis-event:2:1:6', terminalState: 'other' }),
      launch({ eventUrn: 'dis-event:2:1:7', terminalState: 'unresolved' }),
    ];
    const html = renderToStaticMarkup(<EffectorTracksCard launches={allOutcomes} />);
    expect(html).toContain('in flight');
    expect(html).toContain('entity impact');
    expect(html).toContain('ground impact');
    expect(html).toContain('detonated');
    expect(html).toContain('dud');
    expect(html).toContain('other');
    expect(html).toContain('unresolved (no termination seen)');
    expect(html).not.toMatch(/\bmiss\b|\bhit\b/i);
  });

  it('shows a "no target" row and a target asset id row', () => {
    const html = renderToStaticMarkup(
      <EffectorTracksCard
        launches={[
          launch({ eventUrn: 'dis-event:3:1:1', targetAssetId: null }),
          launch({ eventUrn: 'dis-event:3:1:2', targetAssetId: 'dis:1:1:9001' }),
        ]}
      />,
    );
    expect(html).toContain('no target');
    expect(html).toContain('dis:1:1:9001');
  });

  it('shows the late marker, titled "result arrived after the timeout", only on the late row', () => {
    const html = renderToStaticMarkup(
      <EffectorTracksCard
        launches={[
          launch({ eventUrn: 'dis-event:4:1:1', terminalState: 'entity_impact', lateTerminal: false }),
          launch({ eventUrn: 'dis-event:4:1:2', terminalState: 'entity_impact', lateTerminal: true }),
        ]}
      />,
    );
    expect(html).toContain('title="result arrived after the timeout"');
    expect((html.match(/result arrived after the timeout/g) ?? []).length).toBe(1);
  });
});
