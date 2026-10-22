import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTarget } from '../../src/targets.ts';

const block = { kind: 'changed', baseStart: 1, baseEnd: 2, curStart: 1, curEnd: 3 } as const;

test('a block target comes back with only the fields it is made of', () => {
  assert.deepEqual(asTarget({ kind: 'block', id: 'abc', block: { ...block, extra: 1 }, more: true }), { kind: 'block', id: 'abc', block });
});

test('file and group targets are recognised', () => {
  assert.deepEqual(asTarget({ kind: 'file', id: 'abc', note: 'x' }), { kind: 'file', id: 'abc' });
  assert.deepEqual(asTarget({ kind: 'group', ids: ['a'] }), { kind: 'group' });
});

test('anything else a command is called with is not a target', () => {
  const notTargets: unknown[] = [
    undefined,
    null,
    'file',
    42,
    [],
    { scheme: 'file', path: '/a' },
    { kind: 'folder', id: 'abc' },
    { kind: 'file' },
    { kind: 'file', id: '' },
    { kind: 'file', id: 7 },
    { kind: 'block', id: 'abc' },
    { kind: 'block', id: 'abc', block: null },
    { kind: 'block', id: 'abc', block: { ...block, kind: 'moved' } },
    { kind: 'block', id: 'abc', block: { ...block, curEnd: '3' } },
    { kind: 'block', id: 'abc', block: { ...block, curEnd: 2.5 } },
    { kind: 'block', id: 'abc', block: { ...block, baseStart: -1 } },
    { kind: 'block', id: 'abc', block: { ...block, baseEnd: 0 } },
    { kind: 'block', id: 'abc', block: { ...block, curEnd: 0 } },
  ];
  for (const value of notTargets) assert.equal(asTarget(value), undefined, JSON.stringify(value));
});
