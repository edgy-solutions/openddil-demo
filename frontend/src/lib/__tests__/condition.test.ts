// Pin the condition helpers: the words, the one-line statement and the tone
// the telemetry card and interrogation panel render from the same shapes.
import { describe, expect, it } from 'vitest';
import {
  OFF_LEVELS,
  conditionLine,
  conditionTone,
  levelWords,
  sourceWords,
  type Condition,
} from '../condition';

describe('levelWords', () => {
  it('strips the prefix and spaces the name', () => {
    expect(levelWords('CONDITION_LEVEL_SENSOR_FAILED')).toBe('SENSOR FAILED');
    expect(levelWords('CONDITION_LEVEL_NOT_EMITTING')).toBe('NOT EMITTING');
  });
  it('renders unknown or empty as UNKNOWN, never throws', () => {
    expect(levelWords(undefined)).toBe('UNKNOWN');
    expect(levelWords('')).toBe('UNKNOWN');
    expect(levelWords(null)).toBe('UNKNOWN');
  });
  it('keeps an unrecognised string readable', () => {
    expect(levelWords('SOMETHING_NEW')).toBe('SOMETHING NEW');
  });
});

describe('sourceWords', () => {
  it('reads enum names', () => {
    expect(sourceWords('CONDITION_SOURCE_APPEARANCE_DAMAGE')).toBe('appearance damage');
    expect(sourceWords('CONDITION_SOURCE_DATA_HEALTH')).toBe('data health');
  });
  it('reads element short codes, single and "+"-joined', () => {
    expect(sourceWords('emission')).toBe('emission');
    expect(sourceWords('appearance_damage')).toBe('appearance damage');
    expect(sourceWords('appearance_damage+data_health')).toBe('appearance damage + data health');
  });
  it('is empty for nothing', () => {
    expect(sourceWords(undefined)).toBe('');
    expect(sourceWords('')).toBe('');
  });
});

describe('conditionLine', () => {
  it('is null without a condition or level', () => {
    expect(conditionLine(null)).toBeNull();
    expect(conditionLine(undefined)).toBeNull();
    expect(conditionLine({})).toBeNull();
    expect(conditionLine({ moved_by: ['CONDITION_SOURCE_EMISSION'] })).toBeNull();
  });
  it('names the mover and its detail for SENSOR_FAILED', () => {
    const c: Condition = {
      level: 'CONDITION_LEVEL_SENSOR_FAILED',
      moved_by: ['CONDITION_SOURCE_EMISSION'],
      claims: [
        { source: 'CONDITION_SOURCE_EMISSION', level: 'CONDITION_LEVEL_SENSOR_FAILED', detail: 'silent 17 s' },
        { source: 'CONDITION_SOURCE_DATA_HEALTH', level: 'CONDITION_LEVEL_NOMINAL', detail: 'health 99' },
      ],
    };
    expect(conditionLine(c)).toBe('CONDITION SENSOR FAILED · moved by emission (silent 17 s)');
  });
  it('joins two movers and their details', () => {
    const c: Condition = {
      level: 'CONDITION_LEVEL_DEGRADED',
      moved_by: ['CONDITION_SOURCE_APPEARANCE_DAMAGE', 'CONDITION_SOURCE_DATA_HEALTH'],
      claims: [
        { source: 'CONDITION_SOURCE_APPEARANCE_DAMAGE', detail: 'slight damage' },
        { source: 'CONDITION_SOURCE_DATA_HEALTH', detail: 'health 70' },
      ],
    };
    expect(conditionLine(c)).toBe(
      'CONDITION DEGRADED · moved by appearance damage + data health (slight damage; health 70)',
    );
  });
  it('omits the parenthetical when no mover has a detail', () => {
    const c: Condition = {
      level: 'CONDITION_LEVEL_DESTROYED',
      moved_by: ['CONDITION_SOURCE_APPEARANCE_DAMAGE'],
      claims: [{ source: 'CONDITION_SOURCE_APPEARANCE_DAMAGE' }],
    };
    expect(conditionLine(c)).toBe('CONDITION DESTROYED · moved by appearance damage');
  });
  it('counts reporting sources for NOMINAL', () => {
    const c: Condition = {
      level: 'CONDITION_LEVEL_NOMINAL',
      claims: [{}, {}, {}],
    };
    expect(conditionLine(c)).toBe('CONDITION NOMINAL · 3 source(s) reporting');
  });
});

describe('conditionTone', () => {
  const tone = (level?: string) => conditionTone(level ? { level } : null);
  it('maps all seven levels', () => {
    expect(tone('CONDITION_LEVEL_NOMINAL')).toBe('nominal');
    expect(tone('CONDITION_LEVEL_DEGRADED')).toBe('degraded');
    expect(tone('CONDITION_LEVEL_CRITICAL')).toBe('critical');
    expect(tone('CONDITION_LEVEL_SENSOR_FAILED')).toBe('critical');
    expect(tone('CONDITION_LEVEL_NOT_EMITTING')).toBe('off');
    expect(tone('CONDITION_LEVEL_DEACTIVATED')).toBe('off');
    expect(tone('CONDITION_LEVEL_DESTROYED')).toBe('off');
  });
  it('treats unknown and absent as nominal', () => {
    expect(tone('CONDITION_LEVEL_FUTURE')).toBe('nominal');
    expect(tone()).toBe('nominal');
  });
  it('agrees with OFF_LEVELS', () => {
    for (const l of OFF_LEVELS) expect(tone(l)).toBe('off');
  });
});
