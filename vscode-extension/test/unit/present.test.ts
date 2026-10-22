import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, decorationPlan, fenced, insetMatches, insetPlan, lensPlan, lineStats, locate, MAX_INSET_LINE_LENGTH, MAX_INSET_ROWS, statsText } from '../../src/present.ts';
import { computeState } from '../../src/state.ts';

const bytes = (text: string) => Buffer.from(text, 'utf8');

/** The state of a text file Claude edited: `base` is what it was, `cur` is what the editor shows. */
function edited(base: string, cur: string) {
  return computeState({ path: '/w/a.txt', existed: true, baseline: bytes(base), current: { text: cur } });
}

test('rewritten and new lines are marked, with what they replaced', () => {
  const state = edited('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(decorationPlan(state), {
    added: [
      { startLine: 1, endLine: 1, replaced: { lines: ['b'], omitted: 0 } },
      { startLine: 4, endLine: 4, replaced: { lines: [], omitted: 0 } },
    ],
    removed: [],
  });
});

test('lines Claude removed are marked on the line beside the gap', () => {
  const state = edited('a\nb\nc\nd', 'a\nd');
  assert.deepEqual(decorationPlan(state).removed, [{ line: 0, edge: 'below', count: 2, removed: { lines: ['b', 'c'], omitted: 0 }, block: state.blocks[0] }]);
});

test('a gap at the top of the file is marked above its first line', () => {
  const state = edited('a\nb\nc', 'c');
  assert.deepEqual(decorationPlan(state).removed, [{ line: 0, edge: 'above', count: 2, removed: { lines: ['a', 'b'], omitted: 0 }, block: state.blocks[0] }]);
});

test('a gap after the last line is marked below it', () => {
  const state = edited('a\nb\nc', 'a');
  assert.deepEqual(decorationPlan(state).removed, [{ line: 0, edge: 'below', count: 2, removed: { lines: ['b', 'c'], omitted: 0 }, block: state.blocks[0] }]);
});

test('long removed text is cut to a readable excerpt and says how much was left out', () => {
  const lines = Array.from({ length: 45 }, (_, index) => `line ${index}`);
  const state = edited(['keep', ...lines, 'end'].join('\n'), 'keep\nend');
  const [gap] = decorationPlan(state).removed;
  assert.equal(gap?.count, 45);
  assert.equal(gap?.removed.lines.length, 30);
  assert.equal(gap?.removed.lines[0], 'line 0');
  assert.equal(gap?.removed.omitted, 15);
});

test('a very long removed line is cut', () => {
  const state = edited(`keep\n${'x'.repeat(500)}\nend`, 'keep\nend');
  const [gap] = decorationPlan(state).removed;
  assert.equal(gap?.removed.lines[0]?.length, 200);
});

test('a file Claude created is marked from its first line to its last', () => {
  const state = computeState({ path: '/w/new.txt', existed: false, baseline: null, current: { text: 'x\ny\nz' } });
  assert.deepEqual(decorationPlan(state), { added: [{ startLine: 0, endLine: 2, replaced: { lines: [], omitted: 0 } }], removed: [] });
});

test('nothing is marked in a file that is gone, compared as a whole, or unchanged', () => {
  const none = { added: [], removed: [] };
  const deleted = computeState({ path: '/w/a.txt', existed: true, baseline: bytes('a'), current: null });
  assert.deepEqual(decorationPlan(deleted), none);
  const binary = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1, 2]), current: { bytes: Buffer.from([0, 1, 3]) } });
  assert.deepEqual(decorationPlan(binary), none);
  assert.deepEqual(decorationPlan(edited('a\nb', 'a\nb')), none);
});

test('a block has its bar below its last line, and the lines it replaced as rows above its first', () => {
  const state = edited('a\nb\nc\nd\ne\nf', 'a\nB\nc\nf\ng');
  const items = insetPlan(state);
  assert.deepEqual(
    items.map(({ afterLine, rows, omitted, bar, position, total }) => ({ afterLine, rows, omitted, bar, position, total })),
    [
      // b became B: the old line above the new one, and the bar below it.
      { afterLine: 0, rows: ['b'], omitted: 0, bar: false, position: 1, total: 3 },
      { afterLine: 1, rows: [], omitted: 0, bar: true, position: 1, total: 3 },
      // d and e are gone: nothing new to put the bar under, so it closes the removed rows.
      { afterLine: 2, rows: ['d', 'e'], omitted: 0, bar: true, position: 2, total: 3 },
      // g is new: only the bar, below it.
      { afterLine: 4, rows: [], omitted: 0, bar: true, position: 3, total: 3 },
    ],
  );
  assert.deepEqual(items.map(({ block }) => block), [state.blocks[0], state.blocks[0], state.blocks[1], state.blocks[2]]);
});

test('a block that replaced several lines has its bar below the last new one', () => {
  const items = insetPlan(edited('a\nb\nc\nd', 'a\nX\nY\nZ\nd'));
  assert.deepEqual(
    items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })),
    [
      { afterLine: 0, rows: ['b', 'c'], bar: false },
      { afterLine: 3, rows: [], bar: true },
    ],
  );
});

test('lines removed at the top of the file are rows above the first line, closed by the bar', () => {
  const items = insetPlan(edited('a\nb\nc', 'c'));
  assert.deepEqual(items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })), [{ afterLine: -1, rows: ['a', 'b'], bar: true }]);
});

test('lines replaced at the top of the file are rows above the first line; the bar follows the new ones', () => {
  const items = insetPlan(edited('a\nb', 'x\nb'));
  assert.deepEqual(
    items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })),
    [
      { afterLine: -1, rows: ['a'], bar: false },
      { afterLine: 0, rows: [], bar: true },
    ],
  );
});

test('lines removed at the end follow the last line that is left, closed by the bar', () => {
  const items = insetPlan(edited('a\nb\nc', 'a'));
  assert.deepEqual(items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })), [{ afterLine: 0, rows: ['b', 'c'], bar: true }]);
});

test('lines added at the end have their bar below the last line of the file', () => {
  const items = insetPlan(edited('a', 'a\nb'));
  assert.deepEqual(items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })), [{ afterLine: 1, rows: [], bar: true }]);
});

test('lines that were only added have a bar below the last of them and no rows', () => {
  const items = insetPlan(edited('a\nb', 'a\nx\ny\nb'));
  assert.deepEqual(items.map(({ afterLine, rows, bar }) => ({ afterLine, rows, bar })), [{ afterLine: 2, rows: [], bar: true }]);
});

test('insets come top to bottom and no two share a line, so the editor never has to order them', () => {
  const pairs: [base: string, cur: string][] = [
    ['a\nb\nc\nd\ne\nf', 'a\nB\nc\nf\ng'],
    ['a\nb\nc', 'x\nb\nz'],
    ['a\nb\nc\nd', 'b\nd'],
    ['a\nb\nc\nd\ne', 'a\nX\nc\nY\ne'],
  ];
  for (const [base, cur] of pairs) {
    const items = insetPlan(edited(base, cur));
    const lines = items.map(({ afterLine }) => afterLine);
    assert.deepEqual(lines, [...new Set(lines)].sort((first, second) => first - second), JSON.stringify(cur));
    // An inset with neither rows nor a bar would be a zero-line view zone.
    for (const item of items) assert.ok(item.rows.length > 0 || item.bar, JSON.stringify(cur));
  }
});

test('a gap in the decorations names the block its inset stands for', () => {
  const state = edited('a\nb\nc\nd', 'a\nd');
  assert.deepEqual(decorationPlan(state).removed.map(({ block }) => block), [insetPlan(state)[0]?.block]);
});

test('an inset shows at most MAX_INSET_ROWS lines and counts the rest', () => {
  const lines = Array.from({ length: MAX_INSET_ROWS + 25 }, (_, index) => `line ${index}`);
  const [item] = insetPlan(edited(['keep', ...lines, 'end'].join('\n'), 'keep\nend'));
  assert.equal(item?.rows.length, MAX_INSET_ROWS);
  assert.equal(item?.rows[0], 'line 0');
  assert.equal(item?.omitted, 25);
});

test('a very long removed line is cut in its row', () => {
  const [item] = insetPlan(edited(`keep\n${'x'.repeat(MAX_INSET_LINE_LENGTH + 100)}\nend`, 'keep\nend'));
  assert.equal(item?.rows[0]?.length, MAX_INSET_LINE_LENGTH);
});

test('a file Claude created has one bar, below its last line, and no rows', () => {
  const state = computeState({ path: '/w/new.txt', existed: false, baseline: null, current: { text: 'x\ny\nz' } });
  const items = insetPlan(state);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { afterLine: items[0]?.afterLine, rows: items[0]?.rows, bar: items[0]?.bar, position: items[0]?.position, total: items[0]?.total },
    { afterLine: 2, rows: [], bar: true, position: 1, total: 1 },
  );
});

test('an inset is kept while it sits on the same line and shows the same rows', () => {
  const [item] = insetPlan(edited('a\nb\nc', 'a\nx\nc'));
  assert.ok(item);
  // Only the counter and the block's coordinates move when another block is kept or the text around it is edited.
  assert.ok(insetMatches(item, { ...item, position: 2, total: 5, block: { ...item.block, baseStart: 7, baseEnd: 8 } }));
  assert.ok(!insetMatches(item, { ...item, afterLine: item.afterLine + 1 }));
  assert.ok(!insetMatches(item, { ...item, rows: ['other'] }));
  assert.ok(!insetMatches(item, { ...item, rows: [...item.rows, 'more'] }));
  assert.ok(!insetMatches(item, { ...item, omitted: 3 }));
  // Delete the new lines of a block that replaced some and the same rows stay on the same line, now closed by the bar.
  assert.ok(!insetMatches(item, { ...item, bar: !item.bar }));
});

test('no insets in a file that is gone, compared as a whole, or unchanged', () => {
  const deleted = computeState({ path: '/w/a.txt', existed: true, baseline: bytes('a'), current: null });
  assert.deepEqual(insetPlan(deleted), []);
  const binary = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1, 2]), current: { bytes: Buffer.from([0, 1, 3]) } });
  assert.deepEqual(insetPlan(binary), []);
  assert.deepEqual(insetPlan(edited('a\nb', 'a\nb')), []);
});

test('every block gets a lens on its first line, saying what it is', () => {
  const state = edited('a\nb\nc\nd\ne', 'a\nB\nc\nd');
  const lenses = lensPlan(state);
  assert.deepEqual(
    lenses.map(({ line, text }) => ({ line, text })),
    [
      { line: 1, text: 'Changed 1 line' },
      { line: 3, text: 'Removed 1 line' },
    ],
  );
  assert.deepEqual(lenses[0]?.block, state.blocks[0]);
});

test('a lens for lines removed at the end sits on the last line', () => {
  const state = edited('a\nb\nc', 'a');
  assert.deepEqual(lensPlan(state).map(({ line }) => line), [0]);
});

test('a created file has one lens that says so', () => {
  const state = computeState({ path: '/w/new.txt', existed: false, baseline: null, current: { text: 'x\ny' } });
  const [lens, ...rest] = lensPlan(state);
  assert.equal(rest.length, 0);
  assert.equal(lens?.line, 0);
  assert.equal(lens?.text, 'Claude created this file');
});

test('a file that can only be kept or discarded whole has a lens for the file at its top', () => {
  const state = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1]), current: { bytes: Buffer.from([0, 2]) } });
  assert.deepEqual(lensPlan(state), [{ line: 0, text: 'Claude changed this file', block: undefined }]);
});

test('a lens for a whole file says whether Claude changed, created or deleted it', () => {
  const created = computeState({ path: '/w/new.bin', existed: false, baseline: null, current: { bytes: Buffer.from([0, 1]) } });
  assert.equal(lensPlan(created)[0]?.text, 'Claude created this file');
  const deleted = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1]), current: null });
  assert.equal(lensPlan(deleted)[0]?.text, 'Claude deleted this file');
});

test('there are no lenses where nothing is pending or the file is gone', () => {
  assert.deepEqual(lensPlan(edited('a', 'a')), []);
  assert.deepEqual(lensPlan(computeState({ path: '/w/a.txt', existed: true, baseline: bytes('a'), current: null })), []);
});

test('a code fence is longer than any run of backticks inside the text', () => {
  assert.equal(fenced(['a', 'b'], 'ts'), '```ts\na\nb\n```');
  assert.equal(fenced(['```', 'x'], ''), '````\n```\nx\n````');
  assert.equal(fenced(['a `` b'], ''), '```\na `` b\n```');
});

test('a file inside a workspace folder is shown by where it is in that folder', () => {
  assert.deepEqual(locate('/w/app/src/a.ts', ['/w/app'], '/home/me'), { inside: true, directory: 'src' });
  assert.deepEqual(locate('/w/app/a.ts', ['/w/app'], '/home/me'), { inside: true, directory: '' });
  assert.deepEqual(locate('/w/app/a.ts', ['/w/app/'], '/home/me'), { inside: true, directory: '' });
});

test('a folder whose name only starts like the workspace folder is not inside it', () => {
  assert.deepEqual(locate('/w/app2/a.ts', ['/w/app'], '/home/me'), { inside: false, directory: '/w/app2' });
});

test('the innermost of several workspace folders decides where the file is', () => {
  assert.deepEqual(locate('/w/app/pkg/src/a.ts', ['/w/app', '/w/app/pkg'], '/home/me'), { inside: true, directory: 'src' });
});

test('a file outside every workspace folder is shown by its folder, starting from home where it can', () => {
  assert.deepEqual(locate('/home/me/notes/a.md', ['/w/app'], '/home/me'), { inside: false, directory: '~/notes' });
  assert.deepEqual(locate('/home/me/a.md', ['/w/app'], '/home/me'), { inside: false, directory: '~' });
  assert.deepEqual(locate('/home/meadow/a.md', ['/w/app'], '/home/me'), { inside: false, directory: '/home/meadow' });
  assert.deepEqual(locate('/etc/hosts', [], '/home/me'), { inside: false, directory: '/etc' });
});

test('a language name cannot break out of the code fence', () => {
  assert.equal(fenced(['a'], 'ty pe`s\n'), '```types\na\n```');
  assert.equal(fenced(['a'], 'c++'), '```c++\na\n```');
});

// What a window lists: the files in its folders, and the files elsewhere that a session started in them changed.

test('a file inside a window folder is here, whatever sessions are recorded for it', () => {
  assert.equal(classify('/w/app/src/a.ts', [], ['/w/app']), 'here');
  assert.equal(classify('/w/app/a.ts', [], ['/w/app']), 'here');
  assert.equal(classify('/w/app/a.ts', ['/elsewhere'], ['/w/app']), 'here');
  assert.equal(classify('/w/app/a.ts', [], ['/w/app/']), 'here');
});

test('with no folder open every file is here', () => {
  assert.equal(classify('/etc/hosts', [], []), 'here');
  assert.equal(classify('/etc/hosts', ['/w/app'], []), 'here');
});

test('a file elsewhere is outside when a session was started in a window folder or inside one', () => {
  assert.equal(classify('/etc/hosts', ['/w/app'], ['/w/app']), 'outside');
  assert.equal(classify('/etc/hosts', ['/w/app/pkg/src'], ['/w/app']), 'outside');
  assert.equal(classify('/etc/hosts', ['/other', '/w/app/pkg'], ['/w/app']), 'outside', 'any of the sessions');
  assert.equal(classify('/etc/hosts', ['/w/app/'], ['/w/app']), 'outside');
});

test('a file elsewhere is hidden when no session was started in a window folder or inside one', () => {
  assert.equal(classify('/etc/hosts', [], ['/w/app']), 'hidden', 'no session recorded');
  for (const dir of ['/w', '/', '/w/other', '/w/app2', '/w/app-old']) {
    assert.equal(classify('/etc/hosts', [dir], ['/w/app']), 'hidden', dir);
  }
});

test('with several window folders, a session in any of them counts', () => {
  const roots = ['/w/app', '/w/lib'];
  assert.equal(classify('/w/lib/a.ts', [], roots), 'here');
  assert.equal(classify('/etc/hosts', ['/w/lib/src'], roots), 'outside');
  assert.equal(classify('/etc/hosts', ['/w/docs'], roots), 'hidden');
});

test('a folder opened through a symlink counts under its path and its real path', () => {
  const roots = ['/home/me/link', '/data/real'];
  assert.equal(classify('/data/real/a.ts', [], roots), 'here');
  assert.equal(classify('/etc/hosts', ['/data/real/sub'], roots), 'outside');
  assert.equal(classify('/etc/hosts', ['/home/me/link/sub'], roots), 'outside');
});

test('a changed line counts as one added and one removed, as git counts it', () => {
  assert.deepEqual(lineStats(edited('a\nb\nc', 'a\nB\nc')), { added: 1, removed: 1 });
});

test('line counts add up the lines of every block', () => {
  const state = edited('a\nb\nc\nd\ne\nf', 'a\nB\nc\nf\ng');
  // b became B (+1 -1), d and e are gone (-2), g is new (+1).
  assert.deepEqual(lineStats(state), { added: 2, removed: 3 });
});

test('lines only added or only removed count on their own side', () => {
  assert.deepEqual(lineStats(edited('a\nb', 'a\nb\nc\nd')), { added: 2, removed: 0 });
  assert.deepEqual(lineStats(edited('a\nb\nc\nd', 'a\nd')), { added: 0, removed: 2 });
});

test('an edit that changed nothing has no lines to count', () => {
  assert.deepEqual(lineStats(edited('a\nb', 'a\nb')), { added: 0, removed: 0 });
});

test('a file Claude created counts all its lines as added', () => {
  const created = (text: string) => computeState({ path: '/w/new.txt', existed: false, baseline: null, current: { text } });
  assert.deepEqual(lineStats(created('x\ny\nz')), { added: 3, removed: 0 });
});

test('a file that ends in a newline has no extra line for what follows it', () => {
  const created = (text: string) => computeState({ path: '/w/new.txt', existed: false, baseline: null, current: { text } });
  assert.deepEqual(lineStats(created('x\ny\nz\n')), { added: 3, removed: 0 });
  assert.deepEqual(lineStats(created('\n')), { added: 1, removed: 0 });
  assert.deepEqual(lineStats(created('')), { added: 0, removed: 0 });
});

test('a file removed after Claude changed it counts all the lines it had as removed', () => {
  const deleted = (text: string) => computeState({ path: '/w/a.txt', existed: true, baseline: bytes(text), current: null });
  assert.deepEqual(lineStats(deleted('a\nb\nc')), { added: 0, removed: 3 });
  assert.deepEqual(lineStats(deleted('a\nb\nc\n')), { added: 0, removed: 3 });
});

test('a file that can only be kept or discarded whole has no line counts', () => {
  const binary = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1, 2]), current: { bytes: Buffer.from([0, 1, 3]) } });
  assert.equal(lineStats(binary), undefined);
  const createdBinary = computeState({ path: '/w/new.bin', existed: false, baseline: null, current: { bytes: Buffer.from([0, 1]) } });
  assert.equal(lineStats(createdBinary), undefined);
  const deletedBinary = computeState({ path: '/w/a.bin', existed: true, baseline: Buffer.from([0, 1]), current: null });
  assert.equal(lineStats(deletedBinary), undefined);
  const notebook = computeState({ path: '/w/a.ipynb', existed: true, baseline: bytes('{}'), current: { text: '{"a":1}' } });
  assert.equal(lineStats(notebook), undefined);
});

test('line counts read as +added −removed, with a side left out when it has no lines', () => {
  // The minus is U+2212, the sign typography uses, not the hyphen of a file name.
  assert.equal(statsText({ added: 7, removed: 3 }), '+7 −3');
  assert.equal(statsText({ added: 7, removed: 0 }), '+7');
  assert.equal(statsText({ added: 0, removed: 3 }), '−3');
  assert.equal(statsText({ added: 0, removed: 0 }), '');
});
