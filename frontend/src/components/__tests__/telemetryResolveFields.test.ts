import { describe, expect, it } from 'vitest';
import { resolveFields } from '../TelemetryCharts';
import { PLATFORM_CHART_CONFIGS, platformChartConfig } from '../../config/platformChartConfig';

const variant = Object.keys(PLATFORM_CHART_CONFIGS).find(
  (k) => PLATFORM_CHART_CONFIGS[k].fields.length > 0,
) as string;
const config = platformChartConfig(variant);

const live = {
  a: { health: 0.6, temp: 40, load: 20 },
  b: { health: 0.6, temp: 40, load: 20 },
} as unknown as Parameters<typeof resolveFields>[2];

/** Build a nested object from a dot path ending in a Quantity leaf. */
function nest(path: string, leaf: unknown): Record<string, unknown> {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>((acc, k) => ({ [k]: acc }), leaf) as Record<string, unknown>;
}

describe('resolveFields', () => {
  it('treats an empty health block with no live data as empty', () => {
    const r = resolveFields(config, { health: {} }, undefined);
    expect(r.source).toBe('empty');
    expect(r.fields).toEqual([]);
  });

  it('falls through an empty health block to sim-derived fields', () => {
    const r = resolveFields(config, { health: {} }, live);
    expect(r.source).toBe('sim');
    expect(r.fields).toHaveLength(4);
  });

  it('uses sustainment when a configured field carries a Quantity', () => {
    const sus = nest(config.fields[0].path, { value: 42, unit: 'C' });
    const r = resolveFields(config, sus, undefined);
    expect(r.source).toBe('sustainment');
    expect(r.fields[0].hasValue).toBe(true);
  });

  it('treats null sustainment with no live data as empty', () => {
    expect(resolveFields(config, null, undefined).source).toBe('empty');
  });
});
