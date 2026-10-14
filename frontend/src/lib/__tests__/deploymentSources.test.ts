// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deployment,
  fetchJsonObject,
  loadDeployment,
  mergeDeploymentSources,
  moveInputs,
} from '../../deployment';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe('mergeDeploymentSources', () => {
  it('returns undefined when neither source exists', () => {
    expect(mergeDeploymentSources(undefined, undefined)).toBeUndefined();
  });

  it('returns the base when there is no overlay', () => {
    expect(mergeDeploymentSources({ title: 'A' }, undefined)).toEqual({ title: 'A' });
  });

  it('returns the overlay when there is no base', () => {
    expect(mergeDeploymentSources(undefined, { title: 'B' })).toEqual({ title: 'B' });
  });

  it('lets overlay keys win while untouched base keys survive', () => {
    const merged = mergeDeploymentSources(
      { title: 'A', fobs: [1], effectors: { x: 1 }, movement: { y: 2 } },
      { title: 'B', fobs: [2] },
    );
    expect(merged).toEqual({
      title: 'B',
      fobs: [2],
      effectors: { x: 1 },
      movement: { y: 2 },
    });
  });

  it('replaces a base key wholesale rather than deep-merging', () => {
    const merged = mergeDeploymentSources(
      { effectors: { a: 1, b: 2 } },
      { effectors: { c: 3 } },
    );
    expect(merged).toEqual({ effectors: { c: 3 } });
  });
});

describe('fetchJsonObject', () => {
  it('returns a JSON object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ a: 1 })));
    expect(await fetchJsonObject('/x')).toEqual({ a: 1 });
  });

  it('returns undefined on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ a: 1 }, false)));
    expect(await fetchJsonObject('/x')).toBeUndefined();
  });

  it('returns undefined when the body is HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      })),
    );
    expect(await fetchJsonObject('/x')).toBeUndefined();
  });

  it('returns undefined for a JSON array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([1, 2])));
    expect(await fetchJsonObject('/x')).toBeUndefined();
  });

  it('returns undefined for JSON null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    expect(await fetchJsonObject('/x')).toBeUndefined();
  });

  it('returns undefined when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network');
    }));
    expect(await fetchJsonObject('/x')).toBeUndefined();
  });
});

describe('loadDeployment merges both sources', () => {
  it('takes effectors from the base and the title from the overlay', async () => {
    const base = {
      title: 'Base Title',
      effectors: { declaredLoad: { count: 4 } },
    };
    const overlay = { title: 'Overlay Title' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/deployment/deployment.json') return jsonResponse(base);
        if (url === '/deployment-overlay/deployment.json') return jsonResponse(overlay);
        return jsonResponse({}, false);
      }),
    );
    await loadDeployment();
    expect(deployment().title).toBe('Overlay Title');
    expect(moveInputs()?.declaredLoad).toBeDefined();
  });
});
