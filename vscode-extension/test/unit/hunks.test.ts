import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLineEdit,
  computeBlocks,
  createdFileBlocks,
  deletedFileBlocks,
  discardEdit,
  dominantEol,
  keepBlock,
  keepParts,
  keepPartsOfCreatedFile,
  parseDoc,
  printDoc,
  selectedParts,
  textLines,
  type Block,
  type LineRange,
} from '../../src/hunks.ts';
import { applyEdit, randomPair, prng } from './helpers.ts';

const blocksOf = (base: string, cur: string) => computeBlocks(parseDoc(base), parseDoc(cur));

/** Compact form for assertions: kind plus [baseStart,baseEnd) and [curStart,curEnd). */
const shape = (blocks: readonly Block[]) =>
  blocks.map((b) => `${b.kind} base[${b.baseStart},${b.baseEnd}) cur[${b.curStart},${b.curEnd})`);

/** A block described by the text it removes and adds, independent of line numbers. */
const content = (base: string, cur: string, blocks: readonly Block[]) => {
  const baseLines = parseDoc(base).lines;
  const curLines = parseDoc(cur).lines;
  return blocks.map((b) => ({
    removed: baseLines.slice(b.baseStart, b.baseEnd),
    added: curLines.slice(b.curStart, b.curEnd),
  }));
};

test('printDoc reproduces any text exactly, including mixed and odd line endings', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb\r\n', 'a\nb\r\nc', '\n\n', 'a\rb', '\r\n', 'trailing\n\n']) {
    assert.equal(printDoc(parseDoc(text)), text, JSON.stringify(text));
  }
});

test('parseDoc keeps each line with the terminator that follows it', () => {
  assert.deepEqual(parseDoc('a\r\nb'), { lines: ['a', 'b'], eols: ['\r\n', ''] });
  assert.deepEqual(parseDoc(''), { lines: [''], eols: [''] });
  assert.deepEqual(parseDoc('a\n'), { lines: ['a', ''], eols: ['\n', ''] });
});

test('dominantEol picks the most common terminator, the first on a tie, and LF when there is none', () => {
  assert.equal(dominantEol(parseDoc('a\r\nb\r\nc\n')), '\r\n');
  assert.equal(dominantEol(parseDoc('a\nb\r\nc\n')), '\n');
  assert.equal(dominantEol(parseDoc('a\r\nb\n')), '\r\n');
  assert.equal(dominantEol(parseDoc('single line')), '\n');
});

test('identical texts have no blocks', () => {
  assert.deepEqual(blocksOf('a\nb\nc', 'a\nb\nc'), []);
});

test('a change of line endings alone is not a block', () => {
  assert.deepEqual(blocksOf('a\r\nb\r\nc\r\n', 'a\nb\nc\n'), []);
});

test('inserted lines form an added block', () => {
  assert.deepEqual(shape(blocksOf('a\nb\nc', 'a\nb\nX\nY\nc')), ['added base[2,2) cur[2,4)']);
});

test('deleted lines form a removed block anchored at the gap they left', () => {
  assert.deepEqual(shape(blocksOf('a\nb\nc\nd', 'a\nd')), ['removed base[1,3) cur[1,1)']);
});

test('rewritten lines form a changed block', () => {
  assert.deepEqual(shape(blocksOf('a\nb\nc', 'a\nB1\nB2\nc')), ['changed base[1,2) cur[1,3)']);
});

test('separate edits are separate blocks, in document order', () => {
  assert.deepEqual(shape(blocksOf('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')), [
    'changed base[0,1) cur[0,1)',
    'changed base[4,5) cur[4,5)',
  ]);
});

test('a block touching the start and the end of the file is reported correctly', () => {
  assert.deepEqual(shape(blocksOf('b', 'a\nb\nc')), ['added base[0,0) cur[0,1)', 'added base[1,1) cur[2,3)']);
});

test('adding a trailing newline is an added empty last line', () => {
  assert.deepEqual(shape(blocksOf('a\nb', 'a\nb\n')), ['added base[2,2) cur[2,3)']);
});

test('removing a trailing newline is a removed block', () => {
  assert.deepEqual(shape(blocksOf('a\nb\n', 'a\nb')), ['removed base[2,3) cur[2,2)']);
});

test('whitespace changes are real changes', () => {
  assert.deepEqual(shape(blocksOf('a\n  b\nc', 'a\n\tb\nc')), ['changed base[1,2) cur[1,2)']);
});

test('a small change deep inside a large file is found without disturbing its surroundings', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const edited = [...big.slice(0, 2500), 'inserted', ...big.slice(2500)];
  assert.deepEqual(shape(blocksOf(big.join('\n'), edited.join('\n'))), ['added base[2500,2500) cur[2500,2501)']);
});

test('a diff too large to compute falls back to one coarse block instead of failing', () => {
  const before = Array.from({ length: 100 }, (_, i) => `old ${i}`);
  const after = Array.from({ length: 100 }, (_, i) => `new ${i}`);
  const blocks = computeBlocks(parseDoc(before.join('\n')), parseDoc(after.join('\n')), 10);
  assert.deepEqual(shape(blocks), ['changed base[0,100) cur[0,100)']);
});

test('the coarse fallback still leaves identical edges outside the block', () => {
  const before = ['top', ...Array.from({ length: 100 }, (_, i) => `old ${i}`), 'bottom'];
  const after = ['top', ...Array.from({ length: 100 }, (_, i) => `new ${i}`), 'bottom'];
  const blocks = computeBlocks(parseDoc(before.join('\n')), parseDoc(after.join('\n')), 10);
  assert.deepEqual(shape(blocks), ['changed base[1,101) cur[1,101)']);
});

test('a file Claude created is one block covering every line', () => {
  assert.deepEqual(shape(createdFileBlocks(parseDoc('x\ny\n'))), ['added base[0,0) cur[0,3)']);
  assert.deepEqual(shape(createdFileBlocks(parseDoc(''))), ['added base[0,0) cur[0,1)']);
});

test('a file deleted after Claude changed it is one removed block', () => {
  assert.deepEqual(shape(deletedFileBlocks(parseDoc('x\ny'))), ['removed base[0,2) cur[0,0)']);
});

test('keeping a block makes the baseline absorb exactly that block', () => {
  const base = 'a\nb\nc\nd\ne';
  const cur = 'a\nB\nc\nd\nE';
  const [first] = blocksOf(base, cur)!;
  const kept = keepBlock(parseDoc(base), parseDoc(cur), first!);

  assert.equal(printDoc(kept), 'a\nB\nc\nd\ne');
  assert.deepEqual(content(printDoc(kept), cur, computeBlocks(kept, parseDoc(cur))!), [{ removed: ['e'], added: ['E'] }]);
});

test('keeping an added block and a removed block', () => {
  const added = keepBlock(parseDoc('a\nc'), parseDoc('a\nb\nc'), blocksOf('a\nc', 'a\nb\nc')![0]!);
  assert.equal(printDoc(added), 'a\nb\nc');

  const removed = keepBlock(parseDoc('a\nb\nc'), parseDoc('a\nc'), blocksOf('a\nb\nc', 'a\nc')![0]!);
  assert.equal(printDoc(removed), 'a\nc');
});

test('keeping the last line of a file that ends without a newline', () => {
  const base = parseDoc('a\nb');
  const cur = parseDoc('a\nb\nc');
  assert.equal(printDoc(keepBlock(base, cur, blocksOf('a\nb', 'a\nb\nc')![0]!)), 'a\nb\nc');

  const shorter = parseDoc('a');
  assert.equal(printDoc(keepBlock(base, shorter, blocksOf('a\nb', 'a')![0]!)), 'a');
});

test('keeping the removal of every line leaves an empty text, which is one empty line', () => {
  const base = parseDoc('x\ny');
  assert.deepEqual(keepBlock(base, parseDoc(''), deletedFileBlocks(base)[0]!), parseDoc(''));
});

test('keeping a block leaves the untouched baseline lines byte-for-byte as they were', () => {
  const base = 'one\r\ntwo\r\nthree\r\nfour';
  const cur = 'one\r\nTWO\r\nthree\r\nFOUR';
  const kept = keepBlock(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!);
  assert.equal(printDoc(kept), 'one\r\nTWO\r\nthree\r\nfour');
});

test('discarding a changed block restores the baseline lines in the current text', () => {
  const base = 'a\nb\nc';
  const cur = 'a\nB1\nB2\nc';
  const edit = discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!);
  assert.equal(applyEdit(cur, edit), base);
});

test('discarding an added block deletes its lines and their terminators', () => {
  const base = 'a\nc';
  const cur = 'a\nX\nY\nc';
  assert.equal(applyEdit(cur, discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!)), base);
});

test('discarding a removed block puts the lines back', () => {
  const base = 'a\nb\nc\nd';
  const cur = 'a\nd';
  assert.equal(applyEdit(cur, discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!)), base);
});

test('discarding at the very start and the very end of a file', () => {
  for (const [base, cur] of [
    ['b', 'a\nb'],
    ['a', 'a\nb'],
    ['a\nb', 'b'],
    ['a\nb', 'a'],
    ['a\nb\n', 'a\nb'],
    ['a\nb', 'a\nb\n'],
    ['a', ''],
    ['', 'a'],
    ['a\nb', 'x'],
  ] as const) {
    for (const block of blocksOf(base, cur)!) {
      const edit = discardEdit(parseDoc(base), parseDoc(cur), block);
      assert.equal(applyEdit(cur, edit), base, `${JSON.stringify(base)} -> ${JSON.stringify(cur)}`);
    }
  }
});

test('discarded lines come back with the current text\'s line endings', () => {
  const cases = [
    { name: 'a changed block', base: 'a\nb1\nb2\nc', cur: 'a\r\nX\r\nc', restored: 'a\r\nb1\r\nb2\r\nc' },
    { name: 'a removed block', base: 'a\nb1\nb2\nc', cur: 'a\r\nc', restored: 'a\r\nb1\r\nb2\r\nc' },
    { name: 'a removed block before the final newline', base: 'a\nb1\nb2\n', cur: 'a\r\n', restored: 'a\r\nb1\r\nb2\r\n' },
    { name: 'a removed block after the last line', base: 'a\nb1\nb2', cur: 'a\r\nb1', restored: 'a\r\nb1\r\nb2' },
  ];
  for (const { name, base, cur, restored } of cases) {
    const edit = discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!);
    assert.equal(applyEdit(cur, edit), restored, name);
  }
});

test('a text with no line ending of its own takes the baseline\'s', () => {
  const base = 'a\r\nb1\r\nb2';
  const cur = 'a';
  const edit = discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)![0]!);
  assert.equal(applyEdit(cur, edit), base);
});

test('discarding one block leaves every other block exactly as it was', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng';
  const cur = 'a\nB\nc\nd\nX\nf\nG';
  const all = blocksOf(base, cur)!;
  assert.equal(all.length, 3);

  const edit = discardEdit(parseDoc(base), parseDoc(cur), all[1]!);
  const after = applyEdit(cur, edit);
  assert.deepEqual(
    content(base, after, blocksOf(base, after)!),
    [content(base, cur, all)[0], content(base, cur, all)[2]],
  );
});

test('keeping any single block removes exactly that block (200 random edits)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { base, cur } = randomPair(seed);
    const blocks = blocksOf(base, cur)!;
    const expected = content(base, cur, blocks);
    blocks.forEach((block, index) => {
      const kept = printDoc(keepBlock(parseDoc(base), parseDoc(cur), block));
      assert.deepEqual(
        content(kept, cur, blocksOf(kept, cur)!),
        expected.filter((_, i) => i !== index),
        `seed ${seed}, block ${index}`,
      );
    });
  }
});

test('discarding any single block removes exactly that block (200 random edits)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { base, cur } = randomPair(seed);
    const blocks = blocksOf(base, cur)!;
    const expected = content(base, cur, blocks);
    blocks.forEach((block, index) => {
      const after = applyEdit(cur, discardEdit(parseDoc(base), parseDoc(cur), block));
      assert.deepEqual(
        content(base, after, blocksOf(base, after)!),
        expected.filter((_, i) => i !== index),
        `seed ${seed}, block ${index}`,
      );
    });
  }
});

test('keeping every block in turn makes the baseline equal the file, even with repeated lines', () => {
  const random = prng(7);
  for (let round = 0; round < 200; round++) {
    const pick = () => Array.from({ length: Math.floor(random() * 12) }, () => 'abc'[Math.floor(random() * 3)]).join('\n');
    const cur = pick();
    let base = parseDoc(pick());
    for (let guard = 0; guard < 50; guard++) {
      const [next] = computeBlocks(base, parseDoc(cur))!;
      if (!next) break;
      base = keepBlock(base, parseDoc(cur), next);
    }
    assert.equal(printDoc(base), cur);
  }
});

test('discarding every block in turn makes the file equal the baseline, even with repeated lines', () => {
  const random = prng(11);
  for (let round = 0; round < 200; round++) {
    const pick = () => Array.from({ length: Math.floor(random() * 12) }, () => 'abc'[Math.floor(random() * 3)]).join('\n');
    const base = pick();
    let cur = pick();
    for (let guard = 0; guard < 50; guard++) {
      const [next] = computeBlocks(parseDoc(base), parseDoc(cur))!;
      if (!next) break;
      cur = applyEdit(cur, discardEdit(parseDoc(base), parseDoc(cur), next));
    }
    assert.equal(cur, base);
  }
});

test('applying a line edit to text gives what an editor would give (200 random discards, and mixed line endings)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { base, cur } = randomPair(seed);
    for (const block of blocksOf(base, cur)) {
      const edit = discardEdit(parseDoc(base), parseDoc(cur), block);
      assert.equal(applyLineEdit(cur, edit), applyEdit(cur, edit), `seed ${seed}`);
    }
  }

  const base = 'a\r\nb1\r\nb2\nc';
  const cur = 'a\nX\r\nc';
  const edit = discardEdit(parseDoc(base), parseDoc(cur), blocksOf(base, cur)[0]!);
  assert.equal(applyLineEdit(cur, edit), applyEdit(cur, edit));
});

test('a line edit that points outside the text is a bug in the caller, not something to clamp', () => {
  const edit = { startLine: 5, startCharacter: 0, endLine: 5, endCharacter: 0, newText: 'x' };
  assert.throws(() => applyLineEdit('a\nb', edit), RangeError);
  assert.throws(() => applyLineEdit('a\nb', { ...edit, startLine: 0, endLine: 0, endCharacter: 9 }), RangeError);
});

test('a text has the lines an editor shows, and the newline that ends it does not start another', () => {
  assert.equal(textLines(parseDoc('')), 0);
  assert.equal(textLines(parseDoc('a')), 1);
  assert.equal(textLines(parseDoc('a\n')), 1);
  assert.equal(textLines(parseDoc('a\n\n')), 2);
  assert.equal(textLines(parseDoc('a\nb')), 2);
});

/** What `selection` (current-text lines, end-exclusive) picks from the blocks that turn `base` into `cur`. */
const picked = (base: string, cur: string, ...selection: LineRange[]) =>
  selectedParts(blocksOf(base, cur), selection, textLines(parseDoc(cur)));
const range = (start: number, end: number): LineRange => ({ start, end });

test('selected lines pick the part of a block they cover, and nothing of the lines around it', () => {
  const [part, ...more] = picked('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne', range(2, 3));
  assert.equal(more.length, 0);
  assert.deepEqual(part!.ranges, [range(2, 3)]);
  assert.equal(part!.block.kind, 'changed');

  assert.deepEqual(picked('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne', range(0, 5))[0]!.ranges, [range(1, 4)], 'a selection wider than the block is cut to it');
  assert.deepEqual(picked('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne', range(0, 1)), [], 'unchanged lines are no part of any block');
  assert.deepEqual(picked('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne'), [], 'nothing selected');
  assert.deepEqual(picked('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne', range(3, 3)), [], 'an empty range selects nothing');
});

test('a selection across several blocks picks a part from each, and none from the unchanged lines between', () => {
  const parts = picked('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\nE\nf\nG', range(1, 5));
  assert.deepEqual(parts.map((part) => part.ranges), [[range(1, 2)], [range(4, 5)]]);
});

test('several selections in one block are put in order and joined where they touch', () => {
  const parts = picked('a\nz', 'a\n1\n2\n3\n4\n5\n6\nz', range(5, 7), range(2, 3), range(3, 4), range(6, 7));
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0]!.ranges, [range(2, 4), range(5, 7)]);
});

test('a removal is picked when the selection takes in the line above it and the line below it', () => {
  const base = 'a\nb\nc\nd\ne\nf';
  const cur = 'a\nb\nd\ne\nf';
  assert.equal(picked(base, cur, range(1, 3)).length, 1, 'b and d, which the gap sits between');
  assert.deepEqual(picked(base, cur, range(1, 3))[0]!.ranges, [], 'a removal has no lines of its own to pick');
  assert.equal(picked(base, cur, range(0, 5)).length, 1, 'everything');
  assert.deepEqual(picked(base, cur, range(0, 2)), [], 'only the line above');
  assert.deepEqual(picked(base, cur, range(2, 5)), [], 'only the line below');
});

test('a removal at an edge of the text is picked by the one line beside it', () => {
  assert.equal(picked('a\nb\nc', 'b\nc', range(0, 1)).length, 1, 'at the top: the first line');
  assert.deepEqual(picked('a\nb\nc', 'b\nc', range(1, 2)), []);
  assert.equal(picked('a\nb\nc', 'a\nb', range(1, 2)).length, 1, 'at the bottom: the last line');
  assert.deepEqual(picked('a\nb\nc', 'a\nb', range(0, 1)), []);
  // The empty line after a final newline is no line of the text, so the last real line is the one beside the gap.
  assert.equal(picked('a\nb\nc\n', 'a\nb\n', range(1, 2)).length, 1, 'at the bottom of a text that ends in a newline');
});

/** The baseline after keeping `selection` of the changes that turn `base` into `cur`. */
const keptLines = (base: string, cur: string, ...selection: LineRange[]) => {
  const curDoc = parseDoc(cur);
  const parts = selectedParts(blocksOf(base, cur), selection, textLines(curDoc));
  return printDoc(keepParts(parseDoc(base), curDoc, parts));
};
/** The blocks left once `selection` is kept, as what they remove and add. */
const leftOver = (base: string, cur: string, ...selection: LineRange[]) => {
  const kept = keptLines(base, cur, ...selection);
  return content(kept, cur, blocksOf(kept, cur));
};

test('keeping some lines of an added block leaves the lines before and after them to decide', () => {
  const base = 'a\nz';
  const cur = 'a\nN1\nN2\nN3\nz';

  assert.equal(keptLines(base, cur, range(2, 3)), 'a\nN2\nz');
  assert.deepEqual(leftOver(base, cur, range(2, 3)), [
    { removed: [], added: ['N1'] },
    { removed: [], added: ['N3'] },
  ]);
  assert.deepEqual(leftOver(base, cur, range(1, 3)), [{ removed: [], added: ['N3'] }]);
});

test('keeping every line of a block keeps the block, as keeping the block does', () => {
  for (const [base, cur] of [
    ['a\nz', 'a\nN1\nN2\nN3\nz'],
    ['a\nB1\nB2\nz', 'a\nC1\nC2\nC3\nz'],
    ['a\nB1\nB2\nB3\nz', 'a\nC1\nC2\nC3\nz'],
  ] as const) {
    const [block] = blocksOf(base, cur);
    assert.equal(keptLines(base, cur, range(1, 4)), printDoc(keepBlock(parseDoc(base), parseDoc(cur), block!)), `${JSON.stringify(base)}`);
  }
});

test('keeping some of the lines that replaced others leaves the removed lines pending, next to the first lines still to decide', () => {
  const base = 'a\nB1\nB2\nz';
  const cur = 'a\nC1\nC2\nC3\nz';

  assert.equal(keptLines(base, cur, range(2, 3)), 'a\nB1\nB2\nC2\nz');
  assert.deepEqual(leftOver(base, cur, range(2, 3)), [
    { removed: ['B1', 'B2'], added: ['C1'] },
    { removed: [], added: ['C3'] },
  ]);
  assert.deepEqual(leftOver(base, cur, range(1, 2)), [{ removed: ['B1', 'B2'], added: ['C2', 'C3'] }], 'the first line');
  assert.deepEqual(leftOver(base, cur, range(3, 4)), [{ removed: ['B1', 'B2'], added: ['C1', 'C2'] }], 'the last line');
});

test('keeping some of the lines that rewrote as many lines pairs each kept line with the line it replaced', () => {
  const base = 'a\nB1\nB2\nB3\nz';
  const cur = 'a\nC1\nC2\nC3\nz';

  assert.equal(keptLines(base, cur, range(2, 3)), 'a\nB1\nC2\nB3\nz');
  assert.deepEqual(leftOver(base, cur, range(2, 3)), [
    { removed: ['B1'], added: ['C1'] },
    { removed: ['B3'], added: ['C3'] },
  ]);
  assert.deepEqual(leftOver(base, cur, range(1, 2), range(3, 4)), [{ removed: ['B2'], added: ['C2'] }], 'the first and the last');
});

test('keeping a selection that takes in a removal accepts the removal', () => {
  assert.equal(keptLines('a\nb\nc\nd', 'a\nb\nd', range(1, 3)), 'a\nb\nd');
  assert.deepEqual(leftOver('a\nb\nc\nd', 'a\nb\nd', range(1, 3)), []);
  assert.equal(keptLines('a\nb\nc\nd', 'a\nb\nd', range(0, 2)), 'a\nb\nc\nd', 'not when it takes in only one side');
});

test('keeping a selection across several blocks keeps its part of each and leaves the other blocks alone', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng';
  const cur = 'a\nB\nc\nd\nE\nf\nG';

  assert.equal(keptLines(base, cur, range(1, 2), range(6, 7)), 'a\nB\nc\nd\ne\nf\nG');
  assert.deepEqual(leftOver(base, cur, range(1, 2), range(6, 7)), [{ removed: ['e'], added: ['E'] }]);
  assert.equal(keptLines(base, cur, range(0, 7)), cur, 'selecting the whole text keeps all of it');
});

test('keeping lines leaves the line endings of the baseline as they were, and the end of the text without one', () => {
  assert.equal(keptLines('a\r\nB\r\nz', 'a\r\nN1\r\nN2\r\nz', range(2, 3)), 'a\r\nB\r\nN2\r\nz');
  assert.equal(keptLines('a\nb', 'a\nB1\nB2', range(2, 3)), 'a\nb\nB2');
  assert.equal(keptLines('a\nb', 'a\nB1\nB2', range(1, 3)), 'a\nB1\nB2');
});

test('keeping nothing leaves the baseline as it was', () => {
  const base = parseDoc('a\nb\nc');
  assert.deepEqual(keepParts(base, parseDoc('a\nB\nc'), []), base);
});

/** The baseline of a file Claude created once `selection` of it is kept. */
const keptOfCreated = (cur: string, ...selection: LineRange[]) => {
  const curDoc = parseDoc(cur);
  return printDoc(keepPartsOfCreatedFile(curDoc, selectedParts(createdFileBlocks(curDoc), selection, textLines(curDoc))));
};

test('keeping some lines of a file Claude created makes them its baseline, and the lines left read as added', () => {
  const cur = 'a\nb\nc\n';

  assert.equal(keptOfCreated(cur, range(1, 2)), 'b\n');
  assert.deepEqual(content('b\n', cur, blocksOf('b\n', cur)), [
    { removed: [], added: ['a'] },
    { removed: [], added: ['c'] },
  ]);
  assert.equal(keptOfCreated(cur, range(0, 1), range(2, 3)), 'a\nc\n', 'lines apart');
  assert.equal(keptOfCreated(cur, range(0, 3)), cur, 'every line, which leaves nothing to decide');
});

test('the kept lines of a file Claude created end as the file does, in the line ending it uses most', () => {
  assert.equal(keptOfCreated('a\nb\nc', range(2, 3)), 'c');
  assert.equal(keptOfCreated('a\nb\nc', range(0, 1)), 'a');
  assert.deepEqual(content('a', 'a\nb\nc', blocksOf('a', 'a\nb\nc')), [{ removed: [], added: ['b', 'c'] }], 'not an added line break');
  assert.equal(keptOfCreated('a\nb\nc', range(0, 3)), 'a\nb\nc');
  assert.equal(keptOfCreated('a\r\nb\r\nc\r\n', range(0, 2)), 'a\r\nb\r\n');
});

test('keeping lines of a file Claude created leaves every other line pending (200 random texts and selections)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { cur } = randomPair(seed);
    const random = prng(seed * 17 + 3);
    const curDoc = parseDoc(cur);
    const total = textLines(curDoc);
    if (total === 0) continue;
    const selection = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const start = Math.floor(random() * total);
      return range(start, Math.min(total, start + 1 + Math.floor(random() * 6)));
    });
    const selected = new Set(selection.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, i) => start + i)));

    const kept = keepPartsOfCreatedFile(curDoc, selectedParts(createdFileBlocks(curDoc), selection, total));
    const after = computeBlocks(kept, curDoc);
    // Which of two equal lines reads as kept is the diff's choice; how many lines are left is not.
    const pending = after.reduce((sum, block) => sum + block.curEnd - block.curStart, 0);
    assert.equal(pending, total - selected.size, `seed ${seed}`);
    assert.ok(after.every((block) => block.kind === 'added'), `seed ${seed}: nothing reads as removed`);
  }
});

test('keeping a selection takes exactly the selected lines out of the changes (200 random edits and selections)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { base, cur } = randomPair(seed);
    const random = prng(seed * 31 + 5);
    const baseDoc = parseDoc(base);
    const curDoc = parseDoc(cur);
    const blocks = computeBlocks(baseDoc, curDoc);
    const total = textLines(curDoc);
    const selection = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const start = Math.floor(random() * total);
      return range(start, Math.min(total, start + 1 + Math.floor(random() * 6)));
    });

    const parts = selectedParts(blocks, selection, total);
    const next = keepParts(baseDoc, curDoc, parts);
    const after = computeBlocks(next, curDoc);
    const isSelected = (line: number) => selection.some((r) => line >= r.start && line < r.end);
    const partOf = (block: Block) => parts.find((part) => part.block === block);
    const context = `seed ${seed}`;

    // The lines of the text that are still changes are the ones that were, minus the selected ones.
    const pendingBefore = blocks.flatMap((b) => Array.from({ length: b.curEnd - b.curStart }, (_, i) => b.curStart + i));
    const pendingAfter = after.flatMap((b) => Array.from({ length: b.curEnd - b.curStart }, (_, i) => b.curStart + i));
    assert.deepEqual(pendingAfter, pendingBefore.filter((line) => !isSelected(line)), context);

    // The lines that are still removed are the ones that were, except where the selection accepted their replacement.
    const removedBefore = blocks.flatMap((block) => {
      const old = baseDoc.lines.slice(block.baseStart, block.baseEnd);
      if (partOf(block) === undefined) return old;
      const added = block.curEnd - block.curStart;
      const allSelected = Array.from({ length: added }, (_, i) => isSelected(block.curStart + i)).every(Boolean);
      if (allSelected) return [];
      if (old.length === added) return old.filter((_, i) => !isSelected(block.curStart + i));
      return old;
    });
    const removedAfter = after.flatMap((b) => next.lines.slice(b.baseStart, b.baseEnd));
    assert.deepEqual(removedAfter, removedBefore, context);
  }
});
