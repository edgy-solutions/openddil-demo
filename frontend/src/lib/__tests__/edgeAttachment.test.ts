// Edge attachment labeling (declared by the deployment, never inferred —
// see openddil-helm's openddil.validateEdgeAttachment). `parseEdgeAttachments`
// is tested directly, like `parseEgressPane` / `parseReleasedRecordsPanes`:
// reaching it through `loadDeployment` would drag in a fetch stub and a DOM
// write for a function that touches neither.
import { describe, expect, it, vi } from 'vitest';
import { parseEdgeAttachments, edgeAttachment } from '../../deployment';

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
