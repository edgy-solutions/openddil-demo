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

  describe('edge rollup', () => {
    const rollup = {
      element_count: 12,
      critical_count: 2,
      degraded_count: 5,
      avg_temp_c: 41.5,
      avg_load_pct: 63.25,
      observed_at: '2026-01-01T10:20:30Z',
    };
    const sus = () => nest(config.fields[0].path, { value: 42, unit: 'C' });

    it('prefers sustainment over sim over rollup', () => {
      expect(resolveFields(config, sus(), live, rollup).source).toBe('sustainment');
      expect(resolveFields(config, null, live, rollup).source).toBe('sim');
      expect(resolveFields(config, null, undefined, rollup).source).toBe('rollup');
      expect(resolveFields(config, null, undefined, null).source).toBe('empty');
    });

    it('maps rollup values exactly onto the four shared fields', () => {
      const r = resolveFields(config, null, undefined, rollup);
      const sim = resolveFields(config, null, live);
      expect(r.fields.map((f) => f.id)).toEqual(sim.fields.map((f) => f.id));
      expect(r.fields.map((f) => f.label)).toEqual(sim.fields.map((f) => f.label));
      expect(r.fields.map((f) => f.unit)).toEqual(sim.fields.map((f) => f.unit));
      expect(r.fields.map((f) => f.value)).toEqual([2, 5, 41.5, 63.25]);
    });

    it('reads missing numeric keys as 0', () => {
      const r = resolveFields(config, null, undefined, { element_count: 3 });
      expect(r.source).toBe('rollup');
      expect(r.fields.map((f) => f.value)).toEqual([0, 0, 0, 0]);
    });

    it('treats element_count 0 or missing as no rollup', () => {
      expect(resolveFields(config, null, undefined, { ...rollup, element_count: 0 }).source).toBe('empty');
      expect(resolveFields(config, null, undefined, { critical_count: 4 }).source).toBe('empty');
    });
  });
});
