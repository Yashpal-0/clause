import assert from 'node:assert/strict';
import { test } from 'node:test';
import { printDoc } from '../../src/hunks.ts';
import { MAX_TEXT_BYTES, baselineText, computeState, decodeText, encodeText } from '../../src/state.ts';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const BOM = String.fromCharCode(0xfeff);

test('plain UTF-8 decodes to its text', () => {
  assert.deepEqual(decodeText(bytes('héllo\nwörld')), { text: 'héllo\nwörld', bom: false });
});

test('a byte order mark is reported and not left in the text', () => {
  assert.deepEqual(decodeText(bytes(`${BOM}abc`)), { text: 'abc', bom: true });
});

test('bytes that are not valid UTF-8 are not text', () => {
  assert.equal(decodeText(Buffer.from([0x61, 0xff, 0xfe, 0x62])), null);
});

test('bytes containing NUL are not text, even if they happen to be valid UTF-8', () => {
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), null);
});

test('files over the size limit are not compared line by line', () => {
  assert.notEqual(decodeText(Buffer.alloc(MAX_TEXT_BYTES, 0x61)), null);
  assert.equal(decodeText(Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61)), null);
});

test('encodeText gives back the bytes decodeText was given', () => {
  for (const original of ['abc', `${BOM}abc`, 'a\r\nb\n', '']) {
    const decoded = decodeText(bytes(original));
    assert.ok(decoded);
    assert.deepEqual(encodeText(decoded.text, decoded.bom), bytes(original));
  }
});

test('an edited text file is pending as blocks', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\nb\nc'), current: { bytes: bytes('a\nB\nc') } });
  assert.equal(state.situation, 'edited');
  assert.equal(state.granularity, 'blocks');
  assert.equal(state.pending, 1);
  assert.deepEqual(state.blocks.map((block) => block.kind), ['changed']);
  assert.equal(printDoc(state.base!), 'a\nb\nc');
  assert.equal(printDoc(state.cur!), 'a\nB\nc');
});

test('the open buffer can stand in for the file on disk', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\nb'), current: { text: 'a\nB' } });
  assert.equal(state.pending, 1);
});

test('a file that matches its baseline has nothing pending', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\nb'), current: { bytes: bytes('a\nb') } });
  assert.equal(state.pending, 0);
  assert.deepEqual(state.blocks, []);
});

test('a line-ending-only difference is nothing pending', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\r\nb\r\n'), current: { bytes: bytes('a\nb\n') } });
  assert.equal(state.pending, 0);
});

test('a baseline with a byte order mark compares equal to the buffer without it', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes(`${BOM}a\nb`), current: { text: 'a\nb' } });
  assert.equal(state.pending, 0);
  assert.equal(state.bom, true);
});

test('a file Claude created is one added block', () => {
  const state = computeState({ path: '/w/new.ts', existed: false, baseline: null, current: { bytes: bytes('x\ny\n') } });
  assert.equal(state.situation, 'created');
  assert.equal(state.granularity, 'blocks');
  assert.equal(state.pending, 1);
  assert.deepEqual(state.blocks.map((block) => [block.kind, block.curStart, block.curEnd]), [['added', 0, 3]]);
  assert.equal(state.base, null);
});

test('an empty file Claude created is still pending', () => {
  const state = computeState({ path: '/w/new.ts', existed: false, baseline: null, current: { bytes: Buffer.alloc(0) } });
  assert.equal(state.pending, 1);
});

test('a file Claude created and that is gone again has nothing pending', () => {
  const state = computeState({ path: '/w/new.ts', existed: false, baseline: null, current: null });
  assert.equal(state.pending, 0);
});

test('a file removed after Claude changed it is one removed block', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\nb'), current: null });
  assert.equal(state.situation, 'deleted');
  assert.equal(state.granularity, 'blocks');
  assert.equal(state.pending, 1);
  assert.deepEqual(state.blocks.map((block) => [block.kind, block.baseStart, block.baseEnd]), [['removed', 0, 2]]);
  assert.equal(state.cur, null);
});

test('a file that is binary is pending only as a whole, and only if its bytes differ', () => {
  const baseline = Buffer.from([1, 0, 2, 3]);
  const changed = computeState({ path: '/w/img.bin', existed: true, baseline, current: { bytes: Buffer.from([1, 0, 2, 4]) } });
  assert.equal(changed.granularity, 'file');
  assert.equal(changed.pending, 1);
  assert.deepEqual(changed.blocks, []);

  const same = computeState({ path: '/w/img.bin', existed: true, baseline, current: { bytes: Buffer.from(baseline) } });
  assert.equal(same.pending, 0);
});

test('a binary file that was deleted is pending as a whole', () => {
  const state = computeState({ path: '/w/img.bin', existed: true, baseline: Buffer.from([1, 0]), current: null });
  assert.equal(state.situation, 'deleted');
  assert.equal(state.granularity, 'file');
  assert.equal(state.pending, 1);
});

test('a binary file Claude created is pending as a whole', () => {
  const state = computeState({ path: '/w/img.bin', existed: false, baseline: null, current: { bytes: Buffer.from([0, 1]) } });
  assert.equal(state.situation, 'created');
  assert.equal(state.granularity, 'file');
  assert.equal(state.pending, 1);
});

test('a notebook is pending only as a whole, whatever its contents', () => {
  const state = computeState({ path: '/w/n.ipynb', existed: true, baseline: bytes('{"cells":[]}'), current: { bytes: bytes('{"cells":[1]}') } });
  assert.equal(state.granularity, 'file');
  assert.equal(state.pending, 1);
});

test('a notebook is recognised whatever the case of its extension', () => {
  const state = computeState({ path: '/w/N.IPYNB', existed: true, baseline: bytes('{"cells":[]}'), current: { bytes: bytes('{"cells":[1]}') } });
  assert.equal(state.granularity, 'file');
});

test('an open buffer of a file that is only compared as a whole is compared with the baseline bytes', () => {
  const baseline = bytes('{"cells":[]}');
  const same = computeState({ path: '/w/n.ipynb', existed: true, baseline, current: { text: '{"cells":[]}' } });
  assert.equal(same.pending, 0);

  const changed = computeState({ path: '/w/n.ipynb', existed: true, baseline, current: { text: '{"cells":[1]}' } });
  assert.equal(changed.pending, 1);
});

test('a text file that turned into non-text is pending only as a whole', () => {
  const state = computeState({ path: '/w/a.ts', existed: true, baseline: bytes('a\nb'), current: { bytes: Buffer.from([0xff, 0xfe, 0x00]) } });
  assert.equal(state.granularity, 'file');
  assert.equal(state.pending, 1);
});

test('a file over the size limit is pending only as a whole', () => {
  const large = Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61);
  const state = computeState({ path: '/w/big.txt', existed: true, baseline: bytes('a'), current: { bytes: large } });
  assert.equal(state.granularity, 'file');
  assert.equal(state.pending, 1);
});

test('a baseline that can be compared line by line is given as text', () => {
  assert.deepEqual(baselineText('/w/a.ts', bytes(`${BOM}a\nb`)), { text: 'a\nb', bom: true });
});

test('there is no baseline text for a file Claude created, a binary file or a notebook', () => {
  assert.equal(baselineText('/w/new.ts', null), null);
  assert.equal(baselineText('/w/img.bin', Buffer.from([1, 0, 2])), null);
  assert.equal(baselineText('/w/n.ipynb', bytes('{"cells":[]}')), null);
});
