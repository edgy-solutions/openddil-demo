import { describe, expect, it } from 'vitest';
import { parseReports } from '../deployment';

describe('parseReports', () => {
  it('is true only for an object with closesCarriedUp exactly true', () => {
    expect(parseReports({ closesCarriedUp: true })).toEqual({ closesCarriedUp: true });
  });
  it.each([
    ['absent', undefined],
    ['empty object', {}],
    ['string "true"', { closesCarriedUp: 'true' }],
    ['number 1', { closesCarriedUp: 1 }],
    ['false', { closesCarriedUp: false }],
    ['a string', 'true'],
    ['null', null],
    ['an array', [true]],
  ])('is false for %s', (_n, raw) => {
    expect(parseReports(raw)).toEqual({ closesCarriedUp: false });
  });
});
