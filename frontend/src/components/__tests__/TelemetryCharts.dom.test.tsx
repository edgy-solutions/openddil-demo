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

describe('TelemetryCharts condition line', () => {
  afterEach(cleanup);

  const live = { 'E-1': { health: 0.1, temp: 40, load: 50 } };

  it('states the condition and keeps the charts for SENSOR_FAILED', () => {
    render(
      <TelemetryCharts
        telemetry={null}
        platformVariant={null}
        degraded={false}
        liveTelemetry={live}
        condition={{
          level: 'CONDITION_LEVEL_SENSOR_FAILED',
          moved_by: ['CONDITION_SOURCE_EMISSION'],
          claims: [{ source: 'CONDITION_SOURCE_EMISSION', detail: 'silent 17 s' }],
        }}
      />,
    );
    expect(screen.getByTestId('telemetry-condition').textContent).toBe(
      'CONDITION SENSOR FAILED · moved by emission (silent 17 s)',
    );
    expect(screen.getByText('CRITICAL ELEMENTS')).toBeTruthy();
    expect(screen.queryByText('POWERED OFF')).toBeNull();
  });

  it('falls back to the rollup condition', () => {
    const rollup = {
      element_count: 8,
      observed_at: '2026-01-01T10:20:30Z',
      condition: {
        level: 'CONDITION_LEVEL_DEGRADED',
        moved_by: ['CONDITION_SOURCE_DATA_HEALTH'],
        claims: [{ source: 'CONDITION_SOURCE_DATA_HEALTH', detail: 'health 70' }],
      },
    };
    render(
      <TelemetryCharts telemetry={null} platformVariant={null} degraded={false} elementRollup={rollup} />,
    );
    expect(screen.getByTestId('telemetry-condition').textContent).toBe(
      'CONDITION DEGRADED · moved by data health (health 70)',
    );
  });

  it('enters the off block at DESTROYED even when power says nothing', () => {
    render(
      <TelemetryCharts
        telemetry={null}
        platformVariant={null}
        degraded={false}
        liveTelemetry={live}
        isPoweredOff={false}
        condition={{
          level: 'CONDITION_LEVEL_DESTROYED',
          moved_by: ['CONDITION_SOURCE_APPEARANCE_DAMAGE'],
        }}
      />,
    );
    expect(screen.getByText('DESTROYED')).toBeTruthy();
    expect(screen.queryByText('POWERED OFF')).toBeNull();
    expect(screen.queryByText('CRITICAL ELEMENTS')).toBeNull();
    expect(screen.getByTestId('telemetry-condition').textContent).toContain('CONDITION DESTROYED');
  });

  it('keeps POWERED OFF when powered off with no condition', () => {
    render(
      <TelemetryCharts
        telemetry={null}
        platformVariant={null}
        degraded={false}
        liveTelemetry={live}
        isPoweredOff
      />,
    );
    expect(screen.getByText('POWERED OFF')).toBeTruthy();
    expect(screen.queryByTestId('telemetry-condition')).toBeNull();
  });

  it('renders no condition line without a condition', () => {
    render(<TelemetryCharts telemetry={null} platformVariant={null} degraded={false} liveTelemetry={live} />);
    expect(screen.queryByTestId('telemetry-condition')).toBeNull();
  });
});
