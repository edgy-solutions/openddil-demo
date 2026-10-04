// An expired session must not look like a dead feed. classifyShapeError
// is the pure decision function hooks/electric.ts's effect calls; tested
// directly (no React/mount needed) against the real FetchError class the
// installed @electric-sql/client exports.
import { describe, expect, it } from 'vitest';
import { FetchError } from '@electric-sql/client';
import { classifyShapeError } from '../shapeErrors';

describe('classifyShapeError', () => {
  it('a 401 FetchError classifies as session, not transport', () => {
    const err = new FetchError(401, undefined, undefined, {}, '/electric/v1/shape');
    expect(classifyShapeError(true, err, false)).toBe('session');
  });

  it('a 502 FetchError classifies as transport, same as today', () => {
    const err = new FetchError(502, undefined, undefined, {}, '/electric/v1/shape');
    expect(classifyShapeError(true, err, false)).toBe('transport');
  });

  it('an unlabelable table classifies as unlabelable regardless of the error', () => {
    const err = new FetchError(502, undefined, undefined, {}, '/electric/v1/shape');
    expect(classifyShapeError(true, err, true)).toBe('unlabelable');
  });

  it('no error -> null (nothing to report)', () => {
    expect(classifyShapeError(false, false, false)).toBeNull();
  });
});
