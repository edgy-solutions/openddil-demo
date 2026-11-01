// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LINK_HEARTBEAT_S,
  __setLinkDeclarationsForTest,
  declaredLinkIds,
  linkHeartbeatS,
  parseLinkHeartbeatS,
} from '../deployment';
import { linkStatusWhere } from '../hooks/useLinkStatus';

afterEach(() => __setLinkDeclarationsForTest({}));

describe('parseLinkHeartbeatS', () => {
  it('reads a positive number', () => {
    expect(parseLinkHeartbeatS({ heartbeat_s: 45 })).toBe(45);
    expect(parseLinkHeartbeatS({ heartbeat_s: 0.5 })).toBe(0.5);
  });
  it('absent is undefined, silently', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLinkHeartbeatS(undefined)).toBeUndefined();
    expect(parseLinkHeartbeatS({})).toBeUndefined();
    expect(w).not.toHaveBeenCalled();
    w.mockRestore();
  });
  it('drops a non-number or non-positive value with a warning', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const v of [0, -5, '30', NaN, null, true]) {
      expect(parseLinkHeartbeatS({ heartbeat_s: v })).toBeUndefined();
    }
    expect(parseLinkHeartbeatS('x')).toBeUndefined();
    expect(w).toHaveBeenCalledTimes(7);
    w.mockRestore();
  });
  it('linkHeartbeatS falls back to the projector default', () => {
    expect(linkHeartbeatS()).toBe(DEFAULT_LINK_HEARTBEAT_S);
    expect(DEFAULT_LINK_HEARTBEAT_S).toBe(30);
    __setLinkDeclarationsForTest({ linkHeartbeatS: 12 });
    expect(linkHeartbeatS()).toBe(12);
  });
});

describe('declaredLinkIds and linkStatusWhere', () => {
  it('is the sorted, deduplicated union of tiers and childLinks', () => {
    __setLinkDeclarationsForTest({
      tiers: [
        { id: 'region-east', parent: 'root', hasChildren: true },
        { id: 'edge-02', parent: 'region-east', hasChildren: false },
        { id: 'edge-01', parent: 'region-east', hasChildren: false },
      ],
      childLinks: [{ id: 'region-east', hasChildren: true }, { id: 'edge-03', hasChildren: false }],
    });
    expect(declaredLinkIds()).toEqual(['edge-01', 'edge-02', 'edge-03', 'region-east']);
    expect(linkStatusWhere(declaredLinkIds())).toBe("id IN ('edge-01', 'edge-02', 'edge-03', 'region-east')");
  });
  it('every call asks for the same string whatever the input order', () => {
    expect(linkStatusWhere(['b', 'a', 'b'])).toBe(linkStatusWhere(['a', 'b']));
  });
  it('escapes single quotes in ids', () => {
    expect(linkStatusWhere(["o'x"])).toBe("id IN ('o''x')");
  });
  it('declares no links => no where (the unfiltered read)', () => {
    expect(declaredLinkIds()).toEqual([]);
    expect(linkStatusWhere([])).toBeUndefined();
  });
});
