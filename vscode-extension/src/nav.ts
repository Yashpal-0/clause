import { selectedParts, textLines, type Block, type BlockPart, type LineRange } from './hunks.ts';
import type { FileState } from './state.ts';

type BlockRange = Pick<Block, 'baseStart' | 'baseEnd' | 'curStart' | 'curEnd'>;

/**
 * The line a block's CodeLens and "go to" commands sit on. A gap left by
 * removed lines has no line of its own, so it takes the line after it, or the
 * last line when the gap is at the end of the text.
 */
export function anchorLine(block: Block, lineCount: number): number {
  return Math.min(block.curStart, lineCount - 1);
}

/**
 * The block the cursor is in. Lines Claude added or changed are in their block.
 * A removed block has no lines, so it counts the line on either side of the gap;
 * where two gaps share a line, the one above wins.
 */
export function blockAtLine(blocks: readonly Block[], line: number): Block | undefined {
  return blocks.find((block) =>
    block.curStart === block.curEnd
      ? line === block.curStart || line === block.curStart - 1
      : line >= block.curStart && line < block.curEnd,
  );
}

/**
 * The block to go to from the cursor, wrapping around at the end. From inside a
 * block it is the block after that one, not the rest of the same block.
 */
export function nextBlock(blocks: readonly Block[], line: number): Block | undefined {
  const here = blockAtLine(blocks, line);
  if (here !== undefined) return blocks[(blocks.indexOf(here) + 1) % blocks.length];
  return blocks.find((block) => block.curStart > line) ?? blocks[0];
}

export function previousBlock(blocks: readonly Block[], line: number): Block | undefined {
  const here = blockAtLine(blocks, line);
  if (here !== undefined) return blocks[(blocks.indexOf(here) - 1 + blocks.length) % blocks.length];
  return blocks.findLast((block) => block.curStart < line) ?? blocks.at(-1);
}

/**
 * The block to go to once the block that started at `line` has been kept or discarded and the rest have been
 * worked out again: the first one left at or below that line, which is the one that was after it, and the
 * first of all when it was the last, as Next Block wraps. Not the cursor's line: a bar can be clicked
 * while the cursor is elsewhere, and the review goes on from the block that was just settled.
 */
export function blockAfterSettled(blocks: readonly Block[], line: number, lineCount: number): Block | undefined {
  return blocks.find((block) => anchorLine(block, lineCount) >= line) ?? blocks[0];
}

/**
 * The block to bring into view for an edit that started at `line`: the block
 * that line is in, else the one whose anchor line is nearest, the earlier one
 * on a tie. The text can have moved on since the edit was made, so the line
 * need not be inside any block.
 */
export function blockToShow(blocks: readonly Block[], line: number, lineCount: number): Block | undefined {
  const here = blockAtLine(blocks, line);
  if (here !== undefined) return here;
  let nearest: Block | undefined;
  let nearestDistance = Infinity;
  for (const block of blocks) {
    const distance = Math.abs(anchorLine(block, lineCount) - line);
    if (distance < nearestDistance) {
      nearest = block;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Finds the block a command was issued for in freshly computed ones. Positions
 * go stale as the user types, so a block that no longer has exactly these
 * coordinates is not the one they clicked on.
 */
export function findBlock(blocks: readonly Block[], wanted: BlockRange): Block | undefined {
  return blocks.find(
    (block) =>
      block.baseStart === wanted.baseStart &&
      block.baseEnd === wanted.baseEnd &&
      block.curStart === wanted.curStart &&
      block.curEnd === wanted.curEnd,
  );
}

/**
 * The order Next and Previous File walk the pending files: the file Claude changed first comes first, the way
 * Cursor's review does, so a pass through the files follows the work. Files first changed at the same moment go
 * by path, which keeps the order the same however the store listed them. Timestamps are the store's ISO
 * strings, which compare as text.
 */
export function reviewOrder<T extends { readonly path: string; readonly createdAt: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.createdAt === b.createdAt ? a.path.localeCompare(b.path) : a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * The file `step` places from `currentId` in `order`, wrapping at both ends. A current file that is not in the
 * order (the editor shows a file with nothing pending, or none is open) has the first file after it and the
 * last file before it, so the first press always lands on a file.
 */
export function fileAfter<T extends { readonly id: string }>(order: readonly T[], currentId: string | undefined, step: 1 | -1): T | undefined {
  const at = order.findIndex((file) => file.id === currentId);
  if (at === -1) return step === 1 ? order[0] : order.at(-1);
  return order[(at + step + order.length) % order.length];
}

export function blockLabel(block: Block): string {
  const removedCount = block.baseEnd - block.baseStart;
  const addedCount = block.curEnd - block.curStart;
  switch (block.kind) {
    case 'added':
      return `Added ${lines(addedCount)}`;
    case 'removed':
      return `Removed ${lines(removedCount)}`;
    case 'changed':
      return removedCount === addedCount
        ? `Changed ${lines(addedCount)}`
        : `Replaced ${lines(removedCount)} with ${addedCount}`;
  }
}

export function statusText(pending: number, files: number): string {
  return `Clause: ${pending} pending · ${files} ${files === 1 ? 'file' : 'files'}`;
}

/** What is waiting, the way Cursor counts a review: files first, then the changes in them. */
export function countsText(files: number, changes: number): string {
  return `${files} ${files === 1 ? 'file' : 'files'} · ${changes} ${changes === 1 ? 'change' : 'changes'}`;
}

function lines(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

/** A selection as the editor reports it, start before end; `vscode.Selection` fits. */
export interface SelectionLike {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

/**
 * The lines the selections touch. A selection that ends at the very start of a line does not touch that line:
 * selecting whole lines ends there, and keeping them must not take in the line after.
 */
export function selectedLineRanges(selections: readonly SelectionLike[]): LineRange[] {
  return selections.flatMap(({ start, end }): LineRange[] => {
    if (start.line === end.line && start.character === end.character) return [];
    return [{ start: start.line, end: end.character === 0 && end.line > start.line ? end.line : end.line + 1 }];
  });
}

/**
 * What keeping the selected lines would keep, in a file Claude edited or created. A file that is gone has no lines
 * to select, and one compared only as a whole (binary, a notebook, over 2 MB) is kept whole.
 */
export function partsToKeep(state: FileState, selections: readonly SelectionLike[]): BlockPart[] {
  if (state.granularity !== 'blocks' || state.cur === null) return [];
  return selectedParts(state.blocks, selectedLineRanges(selections), textLines(state.cur));
}
