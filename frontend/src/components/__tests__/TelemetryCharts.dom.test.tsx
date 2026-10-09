// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TelemetryCharts from '../TelemetryCharts';
import type { TelemetryLatest } from '../../hooks';

// jsdom has no canvas; the rollup path mounts charts, so stub chart.js.
vi.mock('chart.js', () => {
  class FakeChart {
    static register() {}
    static defaults = { color: '', font: { family: '' } };
    data = { datasets: [{ borderColor: '' }] };
    destroy() {}
    update() {}
  }
  return { Chart: FakeChart, registerables: [] };
});
HTMLCanvasElement.prototype.getContext = (() => ({
  createLinearGradient: () => ({ addColorStop: () => {} }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

describe('TelemetryCharts empty state', () => {
  afterEach(cleanup);

  it('labels an empty health block as NO TELEMETRY', () => {
    const tel = { sustainment: { health: {} } } as unknown as TelemetryLatest;
    render(<TelemetryCharts telemetry={tel} platformVariant={null} degraded={false} />);
    expect(screen.getByTestId('telemetry-empty').textContent).toContain('NO TELEMETRY');
  });

  it('renders the edge rollup with SYNTHESIZED badge and edge note', () => {
    const rollup = {
      element_count: 8,
      critical_count: 1,
      degraded_count: 2,
      avg_temp_c: 40,
      avg_load_pct: 50,
      observed_at: '2026-01-01T10:20:30Z',
    };
    render(
      <TelemetryCharts
        telemetry={null}
        platformVariant={null}
        degraded={false}
        elementRollup={rollup}
        rollupEdgeId="edge-test"
      />,
    );
    expect(screen.getByText('SYNTHESIZED')).toBeTruthy();
    const note = screen.getByTestId('telemetry-rollup').textContent ?? '';
    expect(note).toContain('edge-test');
    expect(note).toContain('10:20:30Z');
    expect(screen.queryByTestId('telemetry-empty')).toBeNull();
  });
});
