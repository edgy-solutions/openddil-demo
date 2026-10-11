// Edge attachment labeling (declared by the deployment, never inferred —
// see openddil-helm's openddil.validateEdgeAttachment). `parseEdgeAttachments`
// is tested directly, like `parseEgressPane` / `parseReleasedRecordsPanes`:
// reaching it through `loadDeployment` would drag in a fetch stub and a DOM
// write for a function that touches neither.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseEdgeAttachments, edgeAttachment, parseChildLinks, childLinkShape, __setChildLinksForTest,
} from '../../deployment';

describe('parseEdgeAttachments', () => {
  it('parses a good list', () => {
    expect(parseEdgeAttachments([
      { id: 'edge-01', attachment: 'tier' },
      { id: 'edge-03', attachment: 'hq' },
    ])).toEqual([
      { id: 'edge-01', attachment: 'tier' },
      { id: 'edge-03', attachment: 'hq' },
    ]);
  });

  it('drops an entry with a bad attachment value, without coercing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEdgeAttachments([
      { id: 'edge-01', attachment: 'tier' },
      { id: 'edge-03', attachment: 'bogus' },
    ])).toEqual([
      { id: 'edge-01', attachment: 'tier' },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops an entry with no id, or a non-object entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEdgeAttachments([
      { attachment: 'hq' },
      'edge-03',
      null,
      { id: 'edge-02', attachment: 'tier' },
    ])).toEqual([
      { id: 'edge-02', attachment: 'tier' },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a missing/non-array key gives undefined, not an empty list', () => {
    expect(parseEdgeAttachments(undefined)).toBeUndefined();
    expect(parseEdgeAttachments(null)).toBeUndefined();
    expect(parseEdgeAttachments({})).toBeUndefined();
  });
});

describe('edgeAttachment', () => {
  it('gives undefined for every edge when nothing was declared (module default)', () => {
    expect(edgeAttachment('edge-01')).toBeUndefined();
    expect(edgeAttachment('edge-99')).toBeUndefined();
  });
});

describe('parseChildLinks', () => {
  it('parses a good list', () => {
    expect(parseChildLinks([
      { id: 'edge-03', hasChildren: false },
      { id: 'region-east', hasChildren: true },
    ])).toEqual([
      { id: 'edge-03', hasChildren: false },
      { id: 'region-east', hasChildren: true },
    ]);
  });

  it('a non-array gives undefined', () => {
    expect(parseChildLinks(undefined)).toBeUndefined();
    expect(parseChildLinks(null)).toBeUndefined();
    expect(parseChildLinks({})).toBeUndefined();
    expect(parseChildLinks('edge-03')).toBeUndefined();
  });

  it.each([
    ['a non-object entry', 'edge-03'],
    ['a null entry', null],
    ['a missing id', { hasChildren: true }],
    ['a blank id', { id: '  ', hasChildren: true }],
    ['a non-boolean hasChildren (string)', { id: 'edge-03', hasChildren: 'true' }],
    ['a missing hasChildren', { id: 'edge-03' }],
    ['a non-boolean hasChildren (number)', { id: 'edge-03', hasChildren: 1 }],
  ])('drops %s with a warning, without coercing', (_label, bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseChildLinks([bad, { id: 'edge-02', hasChildren: false }])).toEqual([
      { id: 'edge-02', hasChildren: false },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('childLinkShape', () => {
  afterEach(() => __setChildLinksForTest(undefined));

  it('gives rollup, leaf, and undefined for an undeclared child', () => {
    __setChildLinksForTest([
      { id: 'region-east', hasChildren: true },
      { id: 'edge-03', hasChildren: false },
    ]);
    expect(childLinkShape('region-east')).toBe('rollup');
    expect(childLinkShape('edge-03')).toBe('leaf');
    expect(childLinkShape('edge-99')).toBeUndefined();
  });

  it('is undefined for every child when nothing was declared', () => {
    __setChildLinksForTest(undefined);
    expect(childLinkShape('edge-03')).toBeUndefined();
  });
});
