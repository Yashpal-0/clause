import assert from 'node:assert/strict';
import { computeBlocks, parseDoc, type LineEdit } from '../../src/hunks.ts';

/**
 * Applies an edit to plain text the way an editor would. Positions that fall
 * outside the text fail the test instead of being clamped, so a wrong range
 * from the code under test cannot go unnoticed.
 */
export function applyEdit(text: string, edit: LineEdit): string {
  const doc = parseDoc(text);

  const offsetOf = (line: number, character: number): number => {
    const content = doc.lines[line];
    assert.ok(content !== undefined, `line ${line} is outside a ${doc.lines.length}-line text`);
    assert.ok(character >= 0 && character <= content.length, `character ${character} is outside line ${line}`);
    let offset = character;
    for (let index = 0; index < line; index++) {
      offset += doc.lines[index]!.length + doc.eols[index]!.length;
    }
    return offset;
  };

  const start = offsetOf(edit.startLine, edit.startCharacter);
  const end = offsetOf(edit.endLine, edit.endCharacter);
  assert.ok(start <= end, 'edit ends before it starts');
  return text.slice(0, start) + edit.newText + text.slice(end);
}

/**
 * Each block as the lines it removes and the lines it adds, which says what a
 * block is without depending on where in the file it sits.
 */
export function blockContents(base: string, cur: string) {
  const baseLines = parseDoc(base).lines;
  const curLines = parseDoc(cur).lines;
  return computeBlocks(parseDoc(base), parseDoc(cur)).map((block) => ({
    removed: baseLines.slice(block.baseStart, block.baseEnd),
    added: curLines.slice(block.curStart, block.curEnd),
  }));
}

/** Small deterministic generator so failures are reproducible. */
export function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A baseline of unique lines and a current version edited with other unique
 * lines, so there is only one sensible way to diff them.
 */
export function randomPair(seed: number) {
  const random = prng(seed);
  const baseLines = Array.from({ length: 5 + Math.floor(random() * 25) }, (_, i) => `L${i}`);
  const curLines = [...baseLines];
  for (let op = 0, count = 1 + Math.floor(random() * 5); op < count; op++) {
    const at = Math.floor(random() * (curLines.length + 1));
    const kind = random();
    if (kind < 0.35) curLines.splice(at, 0, `N${seed}-${op}`);
    else if (kind < 0.7 && at < curLines.length) curLines.splice(at, 1);
    else if (at < curLines.length) curLines[at] = `R${seed}-${op}`;
  }
  return { base: baseLines.join('\n'), cur: curLines.join('\n') };
}
