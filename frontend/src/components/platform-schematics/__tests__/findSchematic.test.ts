import { describe, expect, it } from 'vitest';
import {
  ArtillerySchematic,
  SCHEMATIC_REGISTRY,
  UnknownPlatformBadge,
  findSchematic,
  resolveSchematic,
} from '..';

describe('findSchematic', () => {
  it('returns the registry entry on an exact hit', () => {
    const key = Object.keys(SCHEMATIC_REGISTRY)[0];
    expect(findSchematic(key)).toBe(SCHEMATIC_REGISTRY[key]);
  });

  it('maps *_radar / *_RADAR / *_Sensor to one stable radar component', () => {
    const a = findSchematic('LONGRANGE_radar');
    expect(a).toBeDefined();
    expect(findSchematic('LONGRANGE_radar')).toBe(a);
    expect(findSchematic('Surveillance_RADAR')).toBe(a);
    expect(findSchematic('FOO_Sensor')).toBe(a);
  });

  it('maps *_Launcher / *_Interceptor to the artillery schematic', () => {
    expect(findSchematic('FOO_Launcher')).toBe(ArtillerySchematic);
    expect(findSchematic('FOO_interceptor')).toBe(ArtillerySchematic);
  });

  it('returns undefined for unrecognised or empty input', () => {
    expect(findSchematic('AH-64X')).toBeUndefined();
    expect(findSchematic('')).toBeUndefined();
    expect(findSchematic(null)).toBeUndefined();
    expect(findSchematic(undefined)).toBeUndefined();
  });

  it('resolveSchematic falls through to the unknown badge', () => {
    expect(resolveSchematic('AH-64X')).toBe(UnknownPlatformBadge);
    expect(resolveSchematic('LONGRANGE_radar')).toBe(findSchematic('LONGRANGE_radar'));
  });
});
