// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AlertFeed from '../AlertFeed';
import type { TacticalEvent } from '../../hooks';

afterEach(cleanup);

function ev(id: string, time: string): TacticalEvent {
  return {
    id,
    source: 's',
    type: 'openddil.logistics.v1.severity-transition',
    subject: 'dis:9:9:1',
    severity: 'LOGISTICS_SEVERITY_CRITICAL',
    time,
    data: {
      previous_severity: 'LOGISTICS_SEVERITY_DEGRADED',
      top_factor: 'operational.fault',
      top_factor_description: 'pump seized',
    },
  };
}

describe('AlertFeed', () => {
  it('folds three same-key events into one row with a count chip, transition and cause', () => {
    const events = [
      ev('e3', '2026-01-01T12:08:00Z'),
      ev('e2', '2026-01-01T12:04:00Z'),
      ev('e1', '2026-01-01T12:00:00Z'),
    ];
    const { container } = render(<AlertFeed events={events} />);
    expect(container.querySelectorAll('.border-l-2')).toHaveLength(1);
    expect(screen.getByTestId('alert-repeat-e3').textContent).toBe('×3');
    expect(container.textContent).toContain('DEGRADED → CRITICAL');
    expect(screen.getByTitle('pump seized').textContent).toBe('pump seized');
  });
});
