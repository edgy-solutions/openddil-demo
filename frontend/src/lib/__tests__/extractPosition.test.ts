// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractPosition } from '../../hooks/useFleetAssets';

const m = (value?: number, unit = 'm') => (value === undefined ? { unit } : { unit, value });

describe('extractPosition', () => {
  it('converts an ecef-only position', () => {
    const p = extractPosition({
      position: { ecef: { x: m(6378137), y: m(0), z: m(0) } },
      attitude: {},
    })!;
    expect(p.lat).toBeCloseTo(0, 6);
    expect(p.lon).toBeCloseTo(0, 6);
  });
  it('accepts bare numbers and an absent unit', () => {
    const p = extractPosition({ position: { ecef: { x: 0, y: 6378137, z: { value: 0 } } } })!;
    expect(p.lon).toBeCloseTo(90, 6);
  });
  it('prefers wgs84 when both are present', () => {
    const p = extractPosition({
      position: {
        wgs84: { latitude: 12, longitude: 34 },
        ecef: { x: m(6378137), y: m(0), z: m(0) },
      },
    });
    expect(p).toEqual({ lat: 12, lon: 34 });
  });
  it('returns null for an ecef axis with no value', () => {
    expect(extractPosition({ position: { ecef: { x: m(), y: m(0), z: m(0) } } })).toBeNull();
  });
  it('returns null for a non-metre unit', () => {
    expect(extractPosition({ position: { ecef: { x: m(6378137, 'km'), y: m(0), z: m(0) } } })).toBeNull();
  });
  it('keeps existing wgs84 shapes', () => {
    expect(extractPosition({ position: { wgs84: { lat: 1, lon: 2 } } })).toEqual({ lat: 1, lon: 2 });
    expect(extractPosition({ position: { wgs84: { latitude: m(3, 'deg'), longitude: m(4, 'deg') } } })).toEqual({ lat: 3, lon: 4 });
    expect(extractPosition({})).toBeNull();
  });
  it('keeps a metres altitude, from wgs84 or from the ecef conversion', () => {
    expect(extractPosition({ position: { wgs84: { lat: m(1, 'deg'), lon: m(2, 'deg'), alt: m(1650) } } }))
      .toEqual({ lat: 1, lon: 2, alt: 1650 });
    expect(extractPosition({ position: { ecef: { x: m(6378137 + 1700), y: m(0), z: m(0) } } })!.alt).toBeCloseTo(1700, 3);
  });
  it('drops an altitude that is not metres above the ellipsoid or sea level', () => {
    expect(extractPosition({ position: { wgs84: { lat: 1, lon: 2, alt: m(1.6, 'km') } } })).toEqual({ lat: 1, lon: 2 });
    expect(extractPosition({ position: { wgs84: { lat: 1, lon: 2, alt: m(12), altRef: 'ALT_REF_AGL' } } })).toEqual({ lat: 1, lon: 2 });
  });
});
