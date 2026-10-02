// `parseReleasedRecordsPanes` is called directly, the same way
// tierShape.test.ts calls `parseTier` directly: reaching it through
// `loadDeployment` would test a fetch stub, a JSON parse and a DOM write
// alongside the one thing under examination. A parser is a decision;
// decisions get direct tests (see deployment.ts's own comment on this).
import { describe, expect, it } from 'vitest';
import { parseReleasedRecordsPanes } from '../../deployment';

describe('parseReleasedRecordsPanes', () => {
  it('keeps a complete, well-typed entry', () => {
    const raw = [
      {
        title: 'Released records',
        destination: 'system:records-dest-test',
        kind: 'records.v1',
        columns: [{ header: 'task', pointer: '/task' }],
      },
    ];
    expect(parseReleasedRecordsPanes(raw)).toEqual(raw);
  });

  it('keeps an entry with no kind -- kind is optional', () => {
    const raw = [
      {
        title: 'Released records',
        destination: 'system:records-dest-test',
        columns: [{ header: 'task', pointer: '/task' }],
      },
    ];
    expect(parseReleasedRecordsPanes(raw)).toEqual(raw);
  });

  it('drops an entry with a missing title', () => {
    const raw = [{ destination: 'system:x', columns: [] }];
    expect(parseReleasedRecordsPanes(raw)).toEqual([]);
  });

  it('drops an entry with a non-string destination', () => {
    const raw = [{ title: 'x', destination: 42, columns: [] }];
    expect(parseReleasedRecordsPanes(raw)).toEqual([]);
  });

  it('drops an entry whose kind is present but not a string', () => {
    const raw = [{ title: 'x', destination: 'system:x', kind: 7, columns: [] }];
    expect(parseReleasedRecordsPanes(raw)).toEqual([]);
  });

  it('drops an entry with a malformed column', () => {
    const raw = [
      { title: 'x', destination: 'system:x', columns: [{ header: 'task' }] },
    ];
    expect(parseReleasedRecordsPanes(raw)).toEqual([]);
  });

  it('drops an entry whose columns is not an array', () => {
    const raw = [{ title: 'x', destination: 'system:x', columns: 'not an array' }];
    expect(parseReleasedRecordsPanes(raw)).toEqual([]);
  });

  it('keeps good entries and drops bad ones from the same list', () => {
    const good = {
      title: 'Released records',
      destination: 'system:records-dest-test',
      columns: [{ header: 'task', pointer: '/task' }],
    };
    const bad = { title: '', destination: 'system:x', columns: [] };
    expect(parseReleasedRecordsPanes([good, bad])).toEqual([good]);
  });

  it('returns [] for undefined, null, or a non-array value', () => {
    expect(parseReleasedRecordsPanes(undefined)).toEqual([]);
    expect(parseReleasedRecordsPanes(null)).toEqual([]);
    expect(parseReleasedRecordsPanes('not an array')).toEqual([]);
  });
});
