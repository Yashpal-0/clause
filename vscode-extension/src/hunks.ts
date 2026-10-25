import { diffArrays } from 'diff';

export type Eol = '\n' | '\r\n' | '\r';
export type LineEnd = Eol | '';

/**
 * A text as its lines plus the terminator that followed each one, so that
 * `printDoc(parseDoc(text)) === text` for any text. The last line has no
 * terminator, which makes a text that ends in a newline end in an empty line,
 * the same way editors number lines.
 */
export interface Doc {
  readonly lines: readonly string[];
  readonly eols: readonly LineEnd[];
}

/**
 * A run of lines that differ between the baseline (the file before Claude) and
 * the current text. Ranges are line indexes, end-exclusive. An empty range is
 * the gap where the other side's lines were added or removed.
 */
export interface Block {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly curStart: number;
  readonly curEnd: number;
}

/** Replaces the range with `newText`. Positions are zero-based line and character, as in VS Code. */
export interface LineEdit {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly newText: string;
}

/**
 * Limit on the diff's edit length, which counts a rewritten line twice (once
 * removed, once added), so about 1000 rewritten lines. The search cost grows
 * with the square of it: giving up at this limit took about 0.15 s when
 * measured, and the diff runs on the extension host that every other
 * extension shares. One coarse block that can still be kept or discarded
 * beats a stalled editor.
 */
const DEFAULT_MAX_EDIT_LENGTH = 2000;

const LINE_BREAK = /\r\n|\r|\n/g;

export function parseDoc(text: string): Doc {
  const lines: string[] = [];
  const eols: LineEnd[] = [];
  let lineStart = 0;
  for (const match of text.matchAll(LINE_BREAK)) {
    lines.push(text.slice(lineStart, match.index));
    eols.push(match[0] as Eol);
    lineStart = match.index + match[0].length;
  }
  lines.push(text.slice(lineStart));
  eols.push('');
  return { lines, eols };
}

export function printDoc(doc: Doc): string {
  return doc.lines.map((line, index) => line + doc.eols[index]).join('');
}

/**
 * The most common line terminator; the first one seen on a tie, `fallback`
 * when no line has a terminator.
 */
export function dominantEol(doc: Doc, fallback: Eol = '\n'): Eol {
  const counts = new Map<Eol, number>();
  for (const eol of doc.eols) {
    if (eol !== '') counts.set(eol, (counts.get(eol) ?? 0) + 1);
  }
  let dominant = fallback;
  let highest = 0;
  for (const [eol, count] of counts) {
    if (count > highest) {
      dominant = eol;
      highest = count;
    }
  }
  return dominant;
}

/**
 * The blocks that turn `base` into `cur`, in document order. Line terminators
 * are not compared, so converting a file between CRLF and LF is no change;
 * every other character is, whitespace included.
 *
 * When the edit length exceeds `maxEditLength` the whole differing region
 * comes back as one coarse `changed` block instead of the exact ones.
 */
export function computeBlocks(base: Doc, cur: Doc, maxEditLength = DEFAULT_MAX_EDIT_LENGTH): Block[] {
  const baseLines = base.lines;
  const curLines = cur.lines;

  // Edits are local, so most of a file is an identical head and tail that the
  // diff never needs to see.
  const shortest = Math.min(baseLines.length, curLines.length);
  let head = 0;
  while (head < shortest && baseLines[head] === curLines[head]) head++;
  let tail = 0;
  while (
    tail < shortest - head &&
    baseLines[baseLines.length - 1 - tail] === curLines[curLines.length - 1 - tail]
  ) {
    tail++;
  }
  const baseEnd = baseLines.length - tail;
  const curEnd = curLines.length - tail;

  if (head === baseEnd && head === curEnd) return [];
  if (head === baseEnd || head === curEnd) return [blockOf(head, baseEnd, head, curEnd)];

  const parts = diffArrays(baseLines.slice(head, baseEnd), curLines.slice(head, curEnd), { maxEditLength });
  if (parts === undefined) return [blockOf(head, baseEnd, head, curEnd)];

  const blocks: Block[] = [];
  let basePos = head;
  let curPos = head;
  let open: { baseStart: number; curStart: number } | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (open !== null) {
        blocks.push(blockOf(open.baseStart, basePos, open.curStart, curPos));
        open = null;
      }
      basePos += part.count;
      curPos += part.count;
      continue;
    }
    open ??= { baseStart: basePos, curStart: curPos };
    if (part.removed) basePos += part.count;
    else curPos += part.count;
  }
  if (open !== null) blocks.push(blockOf(open.baseStart, basePos, open.curStart, curPos));
  return blocks;
}

/** A file Claude created: all of it is one added block. */
export function createdFileBlocks(cur: Doc): Block[] {
  return [blockOf(0, 0, 0, cur.lines.length)];
}

/** A file removed after Claude changed it: all of the baseline is one removed block. */
export function deletedFileBlocks(base: Doc): Block[] {
  return [blockOf(0, base.lines.length, 0, 0)];
}

/**
 * `doc` with the lines `start..end` replaced by `replacement`. Every other
 * line keeps its own terminator, so untouched parts stay byte for byte as they
 * were; the new lines use the document's dominant terminator to keep one style.
 */
export function replaceLines(doc: Doc, start: number, end: number, replacement: readonly string[]): Doc {
  const eol = dominantEol(doc);
  const lines = [...doc.lines.slice(0, start), ...replacement, ...doc.lines.slice(end)];
  // No lines at all is the empty text, which parseDoc represents as one empty line.
  if (lines.length === 0) return parseDoc('');

  const eols = [...doc.eols.slice(0, start), ...replacement.map(() => eol), ...doc.eols.slice(end)];
  // A line that used to be last gets a terminator once something follows it,
  // and whichever line is last now must not have one.
  const lastIndex = lines.length - 1;
  return { lines, eols: eols.map((lineEnd, index) => (index === lastIndex ? '' : lineEnd === '' ? eol : lineEnd)) };
}

/** The baseline after the user keeps `block`: `base` with the block's lines replaced by the current ones. */
export function keepBlock(base: Doc, cur: Doc, block: Block): Doc {
  return replaceLines(base, block.baseStart, block.baseEnd, cur.lines.slice(block.curStart, block.curEnd));
}

/** A run of lines of the current text, as indexes, end-exclusive. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * What a selection picks of one block: the runs of the block's current lines it covers, in order and apart from
 * each other. A removal has no lines of its own, so a picked removal has none.
 */
export interface BlockPart {
  readonly block: Block;
  readonly ranges: readonly LineRange[];
}

/**
 * How many lines a text has, counted as editors, `wc -l` and git count them: the empty line a `Doc` ends in after a
 * final newline is no line of the text.
 */
export function textLines(doc: Doc): number {
  return doc.lines.length - (doc.lines.at(-1) === '' ? 1 : 0);
}

/**
 * What `selection` (lines of the current text) picks of each block, top to bottom; blocks it does not reach are left
 * out. A removal has no line to select, so it is picked when the lines on both sides of the gap are selected, and
 * an edge of the text counts as selected: at the top of a text the line below the gap is enough, at the bottom the
 * line above it.
 * @param lineCount the lines the current text has, as `textLines` counts them
 */
export function selectedParts(blocks: readonly Block[], selection: readonly LineRange[], lineCount: number): BlockPart[] {
  const chosen = selection.filter((range) => range.start < range.end);
  if (chosen.length === 0) return [];

  const selects = (line: number) => chosen.some((range) => line >= range.start && line < range.end);
  const parts: BlockPart[] = [];
  for (const block of blocks) {
    if (block.curStart === block.curEnd) {
      const above = block.curStart === 0 || selects(block.curStart - 1);
      const below = block.curStart >= lineCount || selects(block.curStart);
      if (above && below) parts.push({ block, ranges: [] });
      continue;
    }
    const ranges = clipRanges(chosen, block.curStart, block.curEnd);
    if (ranges.length > 0) parts.push({ block, ranges });
  }
  return parts;
}

/**
 * The baseline after the user keeps `parts`, what `selectedParts` picked: only the selected lines of each block join
 * the baseline, so what is left of the block is exactly the lines that were not selected. The result is a baseline
 * to diff `cur` against again, never an edit of `cur`, so typing still never enters the baseline.
 *
 * Lines the block removed stay pending until their replacement is wholly kept, because a removal belongs to the
 * lines that replaced it. They are placed beside the first run of lines left unselected, so that the block that
 * is left pairs them with those lines. A block that rewrote as many lines as it removed is paired line by line
 * instead, so keeping one rewritten line leaves the others as the rewrites they were.
 */
export function keepParts(base: Doc, cur: Doc, parts: readonly BlockPart[]): Doc {
  let kept = base;
  // From the bottom up, so that the blocks still to do are where their line numbers say.
  for (const part of [...parts].sort((a, b) => b.block.baseStart - a.block.baseStart)) {
    kept = replaceLines(kept, part.block.baseStart, part.block.baseEnd, baselineAfterKeeping(base, cur, part));
  }
  return kept;
}

function baselineAfterKeeping(base: Doc, cur: Doc, { block, ranges }: BlockPart): string[] {
  const added = block.curEnd - block.curStart;
  // A picked removal is accepted: none of its lines stays in the baseline.
  if (added === 0) return [];

  const removed = base.lines.slice(block.baseStart, block.baseEnd);
  if (removed.length === added) {
    const selects = (line: number) => ranges.some((range) => line >= range.start && line < range.end);
    return removed.map((line, index) => (selects(block.curStart + index) ? cur.lines[block.curStart + index]! : line));
  }

  const lines: string[] = [];
  let at = block.curStart;
  let removedPlaced = false;
  for (const range of ranges) {
    if (range.start > at && !removedPlaced) {
      lines.push(...removed);
      removedPlaced = true;
    }
    lines.push(...cur.lines.slice(range.start, range.end));
    at = range.end;
  }
  if (at < block.curEnd && !removedPlaced) lines.push(...removed);
  return lines;
}

/**
 * The baseline of a file Claude created once the user keeps `parts` of it: the selected lines as a file of their
 * own, against which the lines left read as added. It ends in a line break when the file does, so that keeping
 * every line leaves nothing pending.
 */
export function keepPartsOfCreatedFile(cur: Doc, parts: readonly BlockPart[]): Doc {
  const eol = dominantEol(cur);
  const kept = parts.flatMap(({ ranges }) => ranges.flatMap((range) => cur.lines.slice(range.start, range.end)));
  return parseDoc(kept.join(eol) + (cur.lines.at(-1) === '' ? eol : ''));
}

/** The parts of `ranges` inside `start..end`, in order, with the ones that touch or overlap joined. */
function clipRanges(ranges: readonly LineRange[], start: number, end: number): LineRange[] {
  const inside = ranges
    .map((range) => ({ start: Math.max(range.start, start), end: Math.min(range.end, end) }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  const joined: LineRange[] = [];
  for (const range of inside) {
    const last = joined.at(-1);
    if (last !== undefined && range.start <= last.end) joined[joined.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else joined.push(range);
  }
  return joined;
}

/**
 * The edit that makes `block` disappear from `cur` by putting the baseline's
 * lines back. Restored lines use the current text's line terminator.
 */
export function discardEdit(base: Doc, cur: Doc, block: Block): LineEdit {
  const eol = dominantEol(cur, dominantEol(base));
  const restored = base.lines.slice(block.baseStart, block.baseEnd);
  const lastLine = cur.lines.length - 1;

  if (block.curEnd > block.curStart) {
    const finalLine = block.curEnd - 1;
    if (restored.length > 0) {
      // Stops before the last line's own terminator, which stays.
      return {
        startLine: block.curStart,
        startCharacter: 0,
        endLine: finalLine,
        endCharacter: lineLength(cur, finalLine),
        newText: restored.join(eol),
      };
    }
    if (finalLine < lastLine) {
      return { startLine: block.curStart, startCharacter: 0, endLine: block.curEnd, endCharacter: 0, newText: '' };
    }
    // The block runs to the unterminated last line, so the terminator that
    // separated it from the line before has to go with it.
    return block.curStart === 0
      ? { startLine: 0, startCharacter: 0, endLine: lastLine, endCharacter: lineLength(cur, lastLine), newText: '' }
      : {
          startLine: block.curStart - 1,
          startCharacter: lineLength(cur, block.curStart - 1),
          endLine: lastLine,
          endCharacter: lineLength(cur, lastLine),
          newText: '',
        };
  }

  if (block.curStart <= lastLine) {
    return {
      startLine: block.curStart,
      startCharacter: 0,
      endLine: block.curStart,
      endCharacter: 0,
      newText: restored.map((line) => line + eol).join(''),
    };
  }
  // The gap is after the last line, which has no terminator to put the lines behind.
  const end = lineLength(cur, lastLine);
  return {
    startLine: lastLine,
    startCharacter: end,
    endLine: lastLine,
    endCharacter: end,
    newText: restored.map((line) => eol + line).join(''),
  };
}

/**
 * `text` with `edit` applied as an editor would apply it. This is how a block
 * is discarded in a file that is not open, so that it comes out exactly as it
 * does in an editor. A position outside the text is a bug in the caller and is
 * reported, never clamped: clamping would discard the wrong lines.
 */
export function applyLineEdit(text: string, edit: LineEdit): string {
  const doc = parseDoc(text);
  const start = offsetOf(doc, edit.startLine, edit.startCharacter);
  const end = offsetOf(doc, edit.endLine, edit.endCharacter);
  if (start > end) throw new RangeError('the edit ends before it starts');
  return text.slice(0, start) + edit.newText + text.slice(end);
}

function offsetOf(doc: Doc, line: number, character: number): number {
  const content = doc.lines[line];
  if (content === undefined || character < 0 || character > content.length) {
    throw new RangeError(`line ${line}, character ${character} is outside a ${doc.lines.length}-line text`);
  }
  let offset = character;
  for (let index = 0; index < line; index++) offset += doc.lines[index]!.length + doc.eols[index]!.length;
  return offset;
}

function blockOf(baseStart: number, baseEnd: number, curStart: number, curEnd: number): Block {
  const kind = baseStart === baseEnd ? 'added' : curStart === curEnd ? 'removed' : 'changed';
  return { kind, baseStart, baseEnd, curStart, curEnd };
}

/** Block ranges come from `computeBlocks` on these same lines, so an index outside them is a bug in the caller. */
function lineLength(doc: Doc, index: number): number {
  const line = doc.lines[index];
  if (line === undefined) throw new RangeError(`line ${index} is outside a ${doc.lines.length}-line text`);
  return line.length;
}
