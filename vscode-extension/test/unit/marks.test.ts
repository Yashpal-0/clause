import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedMarks, folderMarks, MARKER_BADGE, MAX_URIS_PER_EVENT, markerTooltip } from '../../src/marks.ts';

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));
const files = (total: number) => counts(Object.fromEntries(Array.from({ length: total }, (_, index) => [`/file-${index}`, 1])));

test('the badge is one shape, which is neither a letter nor a digit', () => {
  // Git badges are letters (U, M, A, D) and the Problems view's are digits; a colour alone could lose to git's, a shape cannot.
  assert.equal([...MARKER_BADGE].length, 1);
  assert.doesNotMatch(MARKER_BADGE, /[\p{L}\p{N}]/u);
});

test('the tooltip says how many changes are waiting, in the singular and the plural', () => {
  assert.equal(markerTooltip(1), '1 change waiting for Keep or Discard');
  assert.equal(markerTooltip(2), '2 changes waiting for Keep or Discard');
  assert.equal(markerTooltip(14), '14 changes waiting for Keep or Discard');
});

test('nothing is announced while every count is what the window was last told', () => {
  assert.deepEqual(changedMarks(counts({}), counts({})), []);
  assert.deepEqual(changedMarks(counts({ '/a': 1, '/b': 2 }), counts({ '/a': 1, '/b': 2 })), []);
});

test('a new file, a different count and a file that is gone are each announced, and nothing else', () => {
  const before = counts({ '/same': 1, '/more': 1, '/fewer': 3, '/gone': 4 });
  const after = counts({ '/same': 1, '/more': 2, '/fewer': 2, '/new': 1 });

  assert.deepEqual(changedMarks(before, after)?.sort(), ['/fewer', '/gone', '/more', '/new']);
});

test('VS Code lists at most 250 files per event', () => {
  // The extension host keeps the shallowest 250 of a longer list and drops the rest, so the limit is VS Code's, not ours to choose.
  assert.equal(MAX_URIS_PER_EVENT, 250);
});

test('more changed files than one event can list are announced as everything', () => {
  assert.equal(changedMarks(counts({}), files(MAX_URIS_PER_EVENT))?.length, MAX_URIS_PER_EVENT);
  assert.equal(changedMarks(counts({}), files(MAX_URIS_PER_EVENT + 1)), undefined);
  // Files that are gone count as changed files too.
  assert.equal(changedMarks(files(MAX_URIS_PER_EVENT + 1), counts({})), undefined);
});

test('a file marks the folders above it, up to the workspace folder that holds it and no further', () => {
  const marks = folderMarks(['/work/project/src/deep/a.ts'], ['/work/project']);

  assert.deepEqual([...marks.keys()].sort(), ['/work/project', '/work/project/src', '/work/project/src/deep']);
});

test('a file directly in the workspace folder marks that folder and nothing else', () => {
  assert.deepEqual(Object.fromEntries(folderMarks(['/ws/a.ts'], ['/ws'])), { '/ws': 1 });
});

test('a folder counts the files below it, however deep', () => {
  const marks = folderMarks(['/ws/src/a.ts', '/ws/src/b.ts', '/ws/src/deep/c.ts', '/ws/docs/d.md'], ['/ws']);

  assert.deepEqual(Object.fromEntries(marks), { '/ws': 4, '/ws/src': 3, '/ws/src/deep': 1, '/ws/docs': 1 });
});

test('a file outside every workspace folder marks no folder', () => {
  assert.equal(folderMarks(['/elsewhere/deep/a.ts'], ['/ws']).size, 0);
});

test('a folder whose name only begins like the workspace folder is outside it', () => {
  assert.equal(folderMarks(['/ws-other/a.ts'], ['/ws']).size, 0);
});

test('with no workspace folder open there is no folder to mark', () => {
  assert.equal(folderMarks(['/ws/a.ts'], []).size, 0);
});

test('each workspace folder marks the files it holds, and the files in neither stay unmarked', () => {
  const marks = folderMarks(['/one/src/a.ts', '/two/b.ts', '/three/c.ts'], ['/one', '/two']);

  assert.deepEqual(Object.fromEntries(marks), { '/one': 1, '/one/src': 1, '/two': 1 });
});

test('a workspace folder that is the root of the file system is marked, and the walk up stops there', () => {
  assert.deepEqual(Object.fromEntries(folderMarks(['/src/a.ts'], ['/'])), { '/': 1, '/src': 1 });
});
