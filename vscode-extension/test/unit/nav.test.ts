import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Block } from '../../src/hunks.ts';
import { anchorLine, blockAtLine, blockLabel, blockToShow, countsText, fileAfter, findBlock, nextBlock, partsToKeep, previousBlock, reviewOrder, selectedLineRanges, statusText } from '../../src/nav.ts';
import { computeState } from '../../src/state.ts';

const added = (curStart: number, curEnd: number, baseAt = curStart): Block => ({ kind: 'added', baseStart: baseAt, baseEnd: baseAt, curStart, curEnd });
const removed = (curAt: number, baseStart: number, baseEnd: number): Block => ({ kind: 'removed', baseStart, baseEnd, curStart: curAt, curEnd: curAt });
const changed = (baseStart: number, baseEnd: number, curStart: number, curEnd: number): Block => ({ kind: 'changed', baseStart, baseEnd, curStart, curEnd });

test('a block that has lines in the text is anchored on its first line', () => {
  assert.equal(anchorLine(added(4, 7), 20), 4);
  assert.equal(anchorLine(changed(4, 6, 4, 9), 20), 4);
});

test('a removed block is anchored on the line after the gap', () => {
  assert.equal(anchorLine(removed(5, 5, 8), 20), 5);
  assert.equal(anchorLine(removed(0, 0, 2), 20), 0);
});

test('a removed block at the end of the text is anchored on the last line, which is the nearest line there is', () => {
  assert.equal(anchorLine(removed(20, 20, 22), 20), 19);
});

test('the cursor is in a block that added or changed the line it is on, and not in one that ends just above it', () => {
  const blocks = [added(2, 4), changed(10, 11, 8, 10)];
  assert.equal(blockAtLine(blocks, 1), undefined);
  assert.equal(blockAtLine(blocks, 2), blocks[0]);
  assert.equal(blockAtLine(blocks, 3), blocks[0]);
  assert.equal(blockAtLine(blocks, 4), undefined);
  assert.equal(blockAtLine(blocks, 8), blocks[1]);
  assert.equal(blockAtLine(blocks, 9), blocks[1]);
  assert.equal(blockAtLine(blocks, 10), undefined);
});

test('the cursor is in a removed block on either line beside the gap', () => {
  const blocks = [removed(5, 5, 7)];
  assert.equal(blockAtLine(blocks, 3), undefined);
  assert.equal(blockAtLine(blocks, 4), blocks[0]);
  assert.equal(blockAtLine(blocks, 5), blocks[0]);
  assert.equal(blockAtLine(blocks, 6), undefined);
});

test('a line between two removed gaps belongs to the one above it', () => {
  const blocks = [removed(1, 1, 2), removed(2, 3, 4)];
  assert.equal(blockAtLine(blocks, 1), blocks[0]);
  assert.equal(blockAtLine(blocks, 2), blocks[1]);
});

test('there is no block at a line of a text without blocks', () => {
  assert.equal(blockAtLine([], 0), undefined);
});

test('next goes to the first block below the cursor and wraps to the first block after the last', () => {
  const blocks = [added(2, 3), added(6, 8), added(12, 13)];
  assert.equal(nextBlock(blocks, 0), blocks[0]);
  assert.equal(nextBlock(blocks, 4), blocks[1]);
  assert.equal(nextBlock(blocks, 9), blocks[2]);
  assert.equal(nextBlock(blocks, 15), blocks[0]);
});

test('next from inside a block goes to the block after it, not to the lines further down the same block', () => {
  const blocks = [added(2, 6), added(8, 9), added(12, 13)];
  assert.equal(nextBlock(blocks, 2), blocks[1]);
  assert.equal(nextBlock(blocks, 5), blocks[1]);
  assert.equal(nextBlock(blocks, 12), blocks[0]);
});

test('previous goes to the last block above the cursor and wraps to the last block before the first', () => {
  const blocks = [added(2, 3), added(6, 8), added(12, 13)];
  assert.equal(previousBlock(blocks, 15), blocks[2]);
  assert.equal(previousBlock(blocks, 9), blocks[1]);
  assert.equal(previousBlock(blocks, 4), blocks[0]);
  assert.equal(previousBlock(blocks, 0), blocks[2]);
});

test('previous from inside a block goes to the block before it', () => {
  const blocks = [added(2, 6), added(8, 10), added(12, 13)];
  assert.equal(previousBlock(blocks, 9), blocks[0]);
  assert.equal(previousBlock(blocks, 2), blocks[2]);
});

test('with one block, next and previous from inside it stay on it', () => {
  const blocks = [added(3, 5)];
  assert.equal(nextBlock(blocks, 4), blocks[0]);
  assert.equal(previousBlock(blocks, 4), blocks[0]);
});

test('there is nowhere to go in a text without blocks', () => {
  assert.equal(nextBlock([], 3), undefined);
  assert.equal(previousBlock([], 3), undefined);
});

test('block labels say how many lines were added, removed or replaced', () => {
  assert.equal(blockLabel(added(0, 1)), 'Added 1 line');
  assert.equal(blockLabel(added(0, 3)), 'Added 3 lines');
  assert.equal(blockLabel(removed(0, 0, 1)), 'Removed 1 line');
  assert.equal(blockLabel(removed(0, 2, 4)), 'Removed 2 lines');
  assert.equal(blockLabel(changed(0, 3, 0, 3)), 'Changed 3 lines');
  assert.equal(blockLabel(changed(0, 1, 0, 1)), 'Changed 1 line');
  assert.equal(blockLabel(changed(0, 2, 0, 3)), 'Replaced 2 lines with 3');
  assert.equal(blockLabel(changed(0, 1, 0, 4)), 'Replaced 1 line with 4');
  assert.equal(blockLabel(changed(0, 3, 0, 1)), 'Replaced 3 lines with 1');
});

test('the status text counts pending changes and the files they are in', () => {
  assert.equal(statusText(7, 3), 'Clause: 7 pending · 3 files');
  assert.equal(statusText(1, 1), 'Clause: 1 pending · 1 file');
  assert.equal(statusText(2, 1), 'Clause: 2 pending · 1 file');
});

test('a block is found again only by all four of its coordinates', () => {
  const fresh = [added(2, 4), changed(10, 12, 8, 11)];
  assert.equal(findBlock(fresh, { ...fresh[1]! }), fresh[1]);
  assert.equal(findBlock(fresh, { ...fresh[1]!, baseStart: 9 }), undefined);
  assert.equal(findBlock(fresh, { ...fresh[1]!, baseEnd: 13 }), undefined);
  assert.equal(findBlock(fresh, { ...fresh[1]!, curStart: 7 }), undefined);
  assert.equal(findBlock(fresh, { ...fresh[1]!, curEnd: 12 }), undefined);
  assert.equal(findBlock([], fresh[0]!), undefined);
});

test('the block to show is the one the line is in', () => {
  const blocks = [added(2, 4), changed(10, 11, 8, 10)];
  assert.equal(blockToShow(blocks, 3, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 9, 20), blocks[1]);
});

test('between two blocks the block to show is the one whose first line is nearer', () => {
  const blocks = [added(2, 3), added(10, 11)];
  assert.equal(blockToShow(blocks, 5, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 7, 20), blocks[1]);
});

test('halfway between two blocks the block to show is the earlier one', () => {
  const blocks = [added(2, 3), added(10, 11)];
  assert.equal(blockToShow(blocks, 6, 20), blocks[0]);
});

test('above the first block and below the last, the block to show is the nearest end', () => {
  const blocks = [added(5, 6), added(12, 13)];
  assert.equal(blockToShow(blocks, 0, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 19, 20), blocks[1]);
  assert.equal(blockToShow(blocks, 400, 20), blocks[1]);
});

test('a removed block is shown for the line on either side of its gap, and for the lines nearest to it', () => {
  const blocks = [removed(5, 5, 7), added(12, 13)];
  assert.equal(blockToShow(blocks, 4, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 5, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 7, 20), blocks[0]);
  assert.equal(blockToShow(blocks, 9, 20), blocks[1]);
});

test('a block removed at the very end of the text is shown for its last line', () => {
  const blocks = [added(1, 2), removed(20, 20, 22)];
  assert.equal(blockToShow(blocks, 19, 20), blocks[1]);
});

test('there is no block to show in a text without blocks', () => {
  assert.equal(blockToShow([], 3, 20), undefined);
});

const pendingFile = (id: string, createdAt: string, path = `/w/${id}.ts`) => ({ id, path, createdAt });

test('files are reviewed in the order Claude first changed them, oldest first', () => {
  const order = reviewOrder([
    pendingFile('c', '2026-10-22T10:03:00.000Z'),
    pendingFile('a', '2026-10-22T10:01:00.000Z'),
    pendingFile('b', '2026-10-22T10:02:00.000Z'),
  ]);
  assert.deepEqual(order.map((file) => file.id), ['a', 'b', 'c']);
});

test('the review order follows the time, not the path', () => {
  const order = reviewOrder([pendingFile('z', '2026-10-22T09:00:00.000Z', '/w/a.ts'), pendingFile('y', '2026-10-22T11:00:00.000Z', '/w/b.ts')]);
  assert.deepEqual(order.map((file) => file.path), ['/w/a.ts', '/w/b.ts']);
  const flipped = reviewOrder([pendingFile('z', '2026-10-22T12:00:00.000Z', '/w/a.ts'), pendingFile('y', '2026-10-22T11:00:00.000Z', '/w/b.ts')]);
  assert.deepEqual(flipped.map((file) => file.path), ['/w/b.ts', '/w/a.ts']);
});

test('files first changed at the same moment are reviewed in path order, whatever order they were listed in', () => {
  const moment = '2026-10-22T10:00:00.000Z';
  const files = [pendingFile('b', moment, '/w/b.ts'), pendingFile('c', moment, '/w/c.ts'), pendingFile('a', moment, '/w/a.ts')];
  assert.deepEqual(reviewOrder(files).map((file) => file.path), ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
  assert.deepEqual(reviewOrder([...files].reverse()).map((file) => file.path), ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
});

test('putting the files in review order leaves the list it was given as it was', () => {
  const files = [pendingFile('b', '2026-10-22T10:02:00.000Z'), pendingFile('a', '2026-10-22T10:01:00.000Z')];
  const ordered = reviewOrder(files);
  assert.notEqual(ordered, files);
  assert.deepEqual(files.map((file) => file.id), ['b', 'a']);
});

test('there is no review order for no files', () => {
  assert.deepEqual(reviewOrder([]), []);
});

const three = [pendingFile('a', '2026-10-22T10:01:00.000Z'), pendingFile('b', '2026-10-22T10:02:00.000Z'), pendingFile('c', '2026-10-22T10:03:00.000Z')];

test('next file is the one after the current file in the order, and previous file the one before it', () => {
  assert.equal(fileAfter(three, 'a', 1), three[1]);
  assert.equal(fileAfter(three, 'b', 1), three[2]);
  assert.equal(fileAfter(three, 'c', -1), three[1]);
  assert.equal(fileAfter(three, 'b', -1), three[0]);
});

test('next file wraps from the last file to the first, and previous file from the first to the last', () => {
  assert.equal(fileAfter(three, 'c', 1), three[0]);
  assert.equal(fileAfter(three, 'a', -1), three[2]);
});

test('from a file that is not in the order, next file is the first and previous file is the last', () => {
  assert.equal(fileAfter(three, 'elsewhere', 1), three[0]);
  assert.equal(fileAfter(three, 'elsewhere', -1), three[2]);
  assert.equal(fileAfter(three, undefined, 1), three[0]);
  assert.equal(fileAfter(three, undefined, -1), three[2]);
});

test('with one file, next and previous file come back to it', () => {
  const only = [pendingFile('a', '2026-10-22T10:01:00.000Z')];
  assert.equal(fileAfter(only, 'a', 1), only[0]);
  assert.equal(fileAfter(only, 'a', -1), only[0]);
  assert.equal(fileAfter(only, 'elsewhere', 1), only[0]);
});

test('there is no file to go to when none is pending', () => {
  assert.equal(fileAfter([], 'a', 1), undefined);
  assert.equal(fileAfter([], undefined, -1), undefined);
});

test('the counts say the files first and then the changes, each with its own plural', () => {
  assert.equal(countsText(3, 7), '3 files · 7 changes');
  assert.equal(countsText(1, 1), '1 file · 1 change');
  assert.equal(countsText(1, 2), '1 file · 2 changes');
  assert.equal(countsText(2, 2), '2 files · 2 changes');
});

/** A selection as the editor reports it: from a line and character to a line and character. */
const selection = (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

test('a selection is the lines it touches, without the line it ends at the very start of', () => {
  assert.deepEqual(selectedLineRanges([selection(2, 3, 4, 5)]), [{ start: 2, end: 5 }]);
  assert.deepEqual(selectedLineRanges([selection(2, 3, 2, 7)]), [{ start: 2, end: 3 }], 'part of one line');
  assert.deepEqual(selectedLineRanges([selection(2, 0, 4, 0)]), [{ start: 2, end: 4 }], 'whole lines, the way a line is selected');
  assert.deepEqual(selectedLineRanges([selection(2, 5, 3, 0)]), [{ start: 2, end: 3 }], 'the rest of a line and its newline');
});

test('a cursor with nothing selected selects nothing, and several selections are all taken', () => {
  assert.deepEqual(selectedLineRanges([selection(2, 3, 2, 3)]), []);
  assert.deepEqual(selectedLineRanges([selection(1, 0, 1, 0), selection(5, 1, 6, 2), selection(9, 0, 9, 0)]), [{ start: 5, end: 7 }]);
  assert.deepEqual(selectedLineRanges([]), []);
});

test('lines are kept by selecting them in a file Claude edited, and in no other', () => {
  const state = (existed: boolean, baseline: string | null, current: string | null) =>
    computeState({
      path: '/x/file.txt',
      existed,
      baseline: baseline === null ? null : Buffer.from(baseline),
      current: current === null ? null : { text: current },
    });
  const lines = [selection(1, 0, 2, 0)];

  const edited = state(true, 'a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(partsToKeep(edited, lines).length, 1);
  assert.deepEqual(partsToKeep(edited, [selection(0, 0, 1, 0)]), [], 'a selection of unchanged lines');
  assert.deepEqual(partsToKeep(edited, []), [], 'no selection');

  assert.deepEqual(partsToKeep(state(false, null, 'a\nb\n'), lines), [], 'a file Claude created is one block: all or nothing');
  assert.deepEqual(partsToKeep(state(true, 'a\nb\n', null), lines), [], 'a file that is gone');
  assert.deepEqual(partsToKeep(computeState({ path: '/x/pic.bin', existed: true, baseline: Buffer.from([0, 1]), current: { bytes: Buffer.from([0, 2]) } }), lines), [], 'a file that is kept whole');
});
