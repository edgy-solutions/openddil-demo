// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TelemetryCharts from '../TelemetryCharts';
import type { TelemetryLatest } from '../../hooks';

describe('TelemetryCharts empty state', () => {
  afterEach(cleanup);

  it('labels an empty health block as NO TELEMETRY', () => {
    const tel = { sustainment: { health: {} } } as unknown as TelemetryLatest;
    render(<TelemetryCharts telemetry={tel} platformVariant={null} degraded={false} />);
    expect(screen.getByTestId('telemetry-empty').textContent).toContain('NO TELEMETRY');
  });
});
