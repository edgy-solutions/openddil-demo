import { describe, expect, it } from 'vitest';
import { acceptRegionParam, healRegion } from '../regionScope';

describe('acceptRegionParam', () => {
  it('rejects an edge id when fobs declare regions', () => {
    expect(acceptRegionParam('edge-02', ['region-a', 'region-b'])).toBeNull();
  });
  it('accepts a declared region', () => {
    expect(acceptRegionParam('region-b', ['region-a', 'region-b'])).toBe('region-b');
  });
  it('accepts any well-formed param when fobs declare none', () => {
    expect(acceptRegionParam('edge-02', [])).toBe('edge-02');
  });
  it('rejects malformed and missing params', () => {
    expect(acceptRegionParam('a/b?x', [])).toBeNull();
    expect(acceptRegionParam('', [])).toBeNull();
    expect(acceptRegionParam(null, [])).toBeNull();
  });
});

describe('healRegion', () => {
  it('heals an unknown selection to the first observed region', () => {
    expect(healRegion('edge-02', ['region-a'], ['region-c', 'region-b'])).toBe('region-b');
  });
  it('does nothing while nothing is observed', () => {
    expect(healRegion('edge-02', [], [])).toBeNull();
  });
  it('leaves a known selection alone', () => {
    expect(healRegion('region-b', [], ['region-a', 'region-b'])).toBeNull();
    expect(healRegion('region-a', ['region-a'], ['region-b'])).toBeNull();
  });
});
