// Pin the posture vocabulary and the time-in-state boundaries: every tier
// renders from these, so a changed boundary shifts what operators read everywhere.
import { describe, expect, it } from 'vitest';
import {
  countPosture,
  normalizePosture,
  postureLabel,
  postureText,
  timeInState,
  type PostureStatus,
} from '../posture';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('normalizePosture', () => {
  it('keeps known values', () => {
    expect(normalizePosture('emplaced')).toBe('emplaced');
    expect(normalizePosture('march_ordered')).toBe('march_ordered');
  });
  it('maps null, empty and unknown strings to unspecified', () => {
    expect(normalizePosture(null)).toBe('unspecified');
    expect(normalizePosture('')).toBe('unspecified');
    expect(normalizePosture('hovering')).toBe('unspecified');
    expect(normalizePosture(7)).toBe('unspecified');
  });
});

describe('postureLabel', () => {
  it('labels every status', () => {
    expect(postureLabel('emplaced')).toBe('EMPLACED');
    expect(postureLabel('march_ordered')).toBe('MARCH ORDERED');
    expect(postureLabel('moving')).toBe('MOVING');
    expect(postureLabel('emplacing')).toBe('EMPLACING');
    expect(postureLabel('unspecified')).toBe('—');
  });
});

describe('timeInState', () => {
  it('formats at each boundary', () => {
    expect(timeInState(ago(59), NOW)).toBe('59s');
    expect(timeInState(ago(60), NOW)).toBe('1m 0s');
    expect(timeInState(ago(252), NOW)).toBe('4m 12s');
    expect(timeInState(ago(3599), NOW)).toBe('59m 59s');
    expect(timeInState(ago(3600), NOW)).toBe('1h 0m');
    expect(timeInState(ago(86399), NOW)).toBe('23h 59m');
    expect(timeInState(ago(86400), NOW)).toBe('1d 0h');
    expect(timeInState(ago(86400 * 3 + 7200), NOW)).toBe('3d 2h');
  });
  it('is null for null, unparseable and far-future input', () => {
    expect(timeInState(null, NOW)).toBeNull();
    expect(timeInState('not a date', NOW)).toBeNull();
    expect(timeInState(ago(-6), NOW)).toBeNull();
  });
  it('tolerates a few seconds of clock skew', () => {
    expect(timeInState(ago(-3), NOW)).toBe('0s');
  });
});

describe('postureText', () => {
  it('joins label and time, and drops time when unspecified', () => {
    expect(postureText('emplaced', ago(252), NOW)).toBe('EMPLACED 4m 12s');
    expect(postureText('unspecified', ago(252), NOW)).toBe('—');
    expect(postureText('moving', null, NOW)).toBe('MOVING');
  });
});

describe('countPosture', () => {
  it('returns all five keys, zeros included', () => {
    const rows: { posture_status: PostureStatus }[] = [
      { posture_status: 'emplaced' },
      { posture_status: 'emplaced' },
      { posture_status: 'moving' },
    ];
    expect(countPosture(rows)).toEqual({
      unspecified: 0, emplaced: 2, march_ordered: 0, moving: 1, emplacing: 0,
    });
    expect(Object.keys(countPosture([])).sort()).toEqual(
      ['emplaced', 'emplacing', 'march_ordered', 'moving', 'unspecified'],
    );
  });
});
