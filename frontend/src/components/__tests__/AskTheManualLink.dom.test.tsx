// @vitest-environment jsdom
// Synthetic ids and invented hosts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AskTheManualLink from '../AskTheManualLink';
import { __setCortexForTest, parseCortex } from '../../deployment';
import { isSessionExpired, subscribeSessionExpiry } from '../../lib/sessionExpiry';

const BASE = 'https://cortex.example.test';
const IDP = 'example-idp';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  __setCortexForTest(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function on(idp?: string) {
  __setCortexForTest(BASE, idp, { askManual: true });
}

describe('AskTheManualLink drawn', () => {
  it('draws one link with the callsign and id in q', () => {
    on(IDP);
    render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    const links = screen.getAllByRole('link', { name: 'Ask the manual' });
    expect(links).toHaveLength(1);
    const a = links[0] as HTMLAnchorElement;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    const u = new URL(a.getAttribute('href') as string);
    expect(u.origin).toBe(BASE);
    expect(u.pathname).toBe('/ask');
    expect([...u.searchParams.keys()].sort()).toEqual(['idp', 'q']);
    expect(u.searchParams.get('q')).toBe('Asset Example-1 (asset-0001):');
    expect(u.searchParams.get('idp')).toBe(IDP);
    expect(a.title).toBe('Opens in cortex.example.test');
  });

  it('omits idp when none is configured', () => {
    on();
    const { container } = render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    const u = new URL(container.querySelector('a')!.getAttribute('href')!);
    expect([...u.searchParams.keys()]).toEqual(['q']);
  });

  it('uses the id alone without a callsign', () => {
    on(IDP);
    for (const callsign of [undefined, null, '', '  ']) {
      const { container, unmount } = render(<AskTheManualLink assetId="asset-0001" callsign={callsign} />);
      const u = new URL(container.querySelector('a')!.getAttribute('href')!);
      expect(u.searchParams.get('q')).toBe('Asset asset-0001:');
      unmount();
    }
  });
});

describe('AskTheManualLink not drawn', () => {
  it('flag absent', () => {
    __setCortexForTest(BASE, IDP);
    const { container } = render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    expect(container.innerHTML).toBe('');
  });

  it.each([false, 'true', 1])('askManual %j parsed then set', (v) => {
    const parsed = parseCortex({ baseUrl: BASE, askManual: v });
    __setCortexForTest(parsed?.baseUrl, undefined, { askManual: parsed?.askManual });
    const { container } = render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    expect(container.innerHTML).toBe('');
  });

  it('no cortex block', () => {
    __setCortexForTest(undefined);
    const { container } = render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    expect(container.innerHTML).toBe('');
  });

  it.each(['', '   '])('blank asset id %j', (id) => {
    on(IDP);
    const { container } = render(<AskTheManualLink assetId={id} callsign="Example-1" />);
    expect(container.innerHTML).toBe('');
  });

  it('text over 4,000 characters', () => {
    on(IDP);
    const { container } = render(<AskTheManualLink assetId={'x'.repeat(4001)} callsign="Example-1" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('AskTheManualLink carries only callsign and id', () => {
  it('no other asset field reaches the href', () => {
    on(IDP);
    const asset = {
      asset_id: 'asset-0001',
      callsign: 'Example-1',
      force_id: 'SENTINEL-FORCE',
      variant: 'SENTINEL-VARIANT',
      fault_code: 'SENTINEL-FAULT',
      nation: 'SENTINEL-NATION',
      last_sample_at: '2099-01-01T00:00:00Z',
    };
    const Wrapper = () => <AskTheManualLink assetId={asset.asset_id} callsign={asset.callsign} />;
    const { container } = render(<Wrapper />);
    const href = decodeURIComponent(container.querySelector('a')!.getAttribute('href')!);
    for (const v of ['SENTINEL-FORCE', 'SENTINEL-VARIANT', 'SENTINEL-FAULT', 'SENTINEL-NATION', '2099-01-01']) {
      expect(href).not.toContain(v);
    }
  });

  it('no token or session value reaches the href', () => {
    on(IDP);
    localStorage.setItem('k', 'SENTINEL-LS');
    sessionStorage.setItem('k', 'SENTINEL-SS');
    document.cookie = 'sid=SENTINEL-COOKIE';
    const { container } = render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    const href = decodeURIComponent(container.querySelector('a')!.getAttribute('href')!);
    for (const v of ['SENTINEL-LS', 'SENTINEL-SS', 'SENTINEL-COOKIE']) expect(href).not.toContain(v);
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = 'sid=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });
});

describe('AskTheManualLink has no effects', () => {
  it('no fetch on render or click', () => {
    on(IDP);
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    fireEvent.click(screen.getByRole('link', { name: 'Ask the manual' }));
    expect(f).toHaveBeenCalledTimes(0);
  });

  it('no storage write, no cookie change, no session-store write', () => {
    on(IDP);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const rem = vi.spyOn(Storage.prototype, 'removeItem');
    const clr = vi.spyOn(Storage.prototype, 'clear');
    const cookieBefore = document.cookie;
    const store = vi.fn();
    const unsub = subscribeSessionExpiry(store);
    const expiredBefore = isSessionExpired();
    render(<AskTheManualLink assetId="asset-0001" callsign="Example-1" />);
    fireEvent.click(screen.getByRole('link', { name: 'Ask the manual' }));
    unsub();
    expect(set).toHaveBeenCalledTimes(0);
    expect(rem).toHaveBeenCalledTimes(0);
    expect(clr).toHaveBeenCalledTimes(0);
    expect(document.cookie).toBe(cookieBefore);
    expect(store).toHaveBeenCalledTimes(0);
    expect(isSessionExpired()).toBe(expiredBefore);
  });
});

describe('parseCortex askManual', () => {
  it('true is kept', () => {
    expect(parseCortex({ baseUrl: BASE, askManual: true })).toEqual({ baseUrl: BASE, askManual: true });
  });

  it('absent sets no key and does not warn', () => {
    const out = parseCortex({ baseUrl: BASE });
    expect(out).toEqual({ baseUrl: BASE });
    expect(out && 'askManual' in out).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([false, 'true', 1, {}, null])('%j sets no key', (v) => {
    const out = parseCortex({ baseUrl: BASE, askManual: v });
    expect(out).toEqual({ baseUrl: BASE });
    expect(out && 'askManual' in out).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(v === null ? 0 : 1);
    if (v !== null) expect(console.warn).toHaveBeenCalledWith('[deployment] cortex askManual dropped: must be true');
  });

  it('no baseUrl gives undefined', () => {
    expect(parseCortex({ askManual: true })).toBeUndefined();
  });
});
