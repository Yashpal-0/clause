import { dirname, relative, resolve, sep } from 'node:path';
import { textLines, type Block, type Doc } from './hunks.ts';
import { anchorLine, blockLabel } from './nav.ts';
import type { FileState } from './state.ts';

/**
 * A hover shows enough of the removed text to recognise it; the diff editor is
 * for reading all of it. Past these sizes a hover is a wall of text.
 */
const MAX_EXCERPT_LINES = 30;
const MAX_EXCERPT_LINE_LENGTH = 200;

/**
 * An inset shows removed lines as real rows in the editor, so it can afford far
 * more than a hover, but a block that dropped thousands of lines would push the
 * rest of the file out of sight. The cut is not hiding anything: Open diff shows
 * all of it, and the last row says how many lines the inset left out.
 */
export const MAX_INSET_ROWS = 200;
export const MAX_INSET_LINE_LENGTH = 400;

/** Lines of text cut down for display. */
export interface Excerpt {
  readonly lines: readonly string[];
  /** How many lines came after the last one shown. */
  readonly omitted: number;
}

/** Lines Claude added or rewrote; `endLine` is inclusive. */
export interface AddedRange {
  readonly startLine: number;
  readonly endLine: number;
  /** What the lines replaced; empty when they are new. */
  readonly replaced: Excerpt;
}

/** Lines Claude removed. They are not in the editor, so the marker sits on the line beside the gap. */
export interface RemovedGap {
  readonly line: number;
  /** Which side of `line` the gap is on. */
  readonly edge: 'above' | 'below';
  readonly count: number;
  readonly removed: Excerpt;
  /** The block the gap is for, so that an inset standing in for the marker can be told apart. */
  readonly block: Block;
}

export interface DecorationPlan {
  readonly added: readonly AddedRange[];
  readonly removed: readonly RemovedGap[];
}

/** A CodeLens group: `block` is undefined for a file that can only be kept or discarded as a whole. */
export interface LensItem {
  readonly line: number;
  readonly text: string;
  readonly block: Block | undefined;
}

/**
 * One row-block of the Cursor-style view. The lines Claude added are the
 * editor's own lines, so the lines it removed can only be rows above them and
 * the bar only a row below them: a block that replaced lines has two insets,
 * one that only removed lines has rows closed by the bar, and one that only
 * added lines has the bar alone.
 */
export interface InsetItem {
  readonly block: Block;
  /** The 0-based line the inset follows; -1 puts it above the first line. */
  readonly afterLine: number;
  /** The lines the block removed, cut for display. */
  readonly rows: readonly string[];
  /** How many removed lines come after the last row. */
  readonly omitted: number;
  /** Whether the inset ends in the bar, on a row of its own. */
  readonly bar: boolean;
  /** 1-based place among this file's blocks, and how many there are. */
  readonly position: number;
  readonly total: number;
}

const FILE_TEXT: Record<FileState['situation'], string> = {
  edited: 'Claude changed this file',
  created: 'Claude created this file',
  deleted: 'Claude deleted this file',
};

/** What to mark in an editor showing `state`'s file. */
export function decorationPlan(state: FileState): DecorationPlan {
  const { cur } = state;
  if (state.granularity !== 'blocks' || cur === null) return { added: [], removed: [] };

  const baseLines = state.base?.lines ?? [];
  const added: AddedRange[] = [];
  const removed: RemovedGap[] = [];
  for (const block of state.blocks) {
    const replaced = excerpt(baseLines.slice(block.baseStart, block.baseEnd));
    if (block.kind === 'removed') {
      const atTop = block.curStart === 0;
      removed.push({
        line: atTop ? 0 : block.curStart - 1,
        edge: atTop ? 'above' : 'below',
        count: block.baseEnd - block.baseStart,
        removed: replaced,
        block,
      });
    } else {
      added.push({ startLine: block.curStart, endLine: block.curEnd - 1, replaced });
    }
  }
  return { added, removed };
}

/**
 * The insets for an editor showing `state`'s file, top to bottom. A file that
 * can only be kept whole, or is gone, has none: it has no text to put them in.
 * No two follow the same line (an unchanged line separates blocks, and a
 * block's new lines separate its own two insets), so the editor never has to
 * decide which of two on one line comes first.
 */
export function insetPlan(state: FileState): InsetItem[] {
  if (state.granularity !== 'blocks' || state.cur === null) return [];

  const baseLines = state.base?.lines ?? [];
  return state.blocks.flatMap((block, index): InsetItem[] => {
    const removed = baseLines.slice(block.baseStart, block.baseEnd);
    const place = { block, position: index + 1, total: state.blocks.length };
    const added = block.curEnd > block.curStart;
    const aboveNewLines: InsetItem = {
      ...place,
      afterLine: block.curStart - 1,
      rows: removed.slice(0, MAX_INSET_ROWS).map((line) => line.slice(0, MAX_INSET_LINE_LENGTH)),
      omitted: Math.max(0, removed.length - MAX_INSET_ROWS),
      bar: !added,
    };
    if (!added) return [aboveNewLines];

    const belowNewLines: InsetItem = { ...place, afterLine: block.curEnd - 1, rows: [], omitted: 0, bar: true };
    return removed.length === 0 ? [belowNewLines] : [aboveNewLines, belowNewLines];
  });
}

/**
 * Whether an inset already on screen can stand in for `wanted`. The block's
 * coordinates and its place in the list are not part of what an inset draws, so
 * keeping one block does not rebuild the insets of the blocks that stay.
 */
export function insetMatches(live: InsetItem, wanted: InsetItem): boolean {
  return (
    live.afterLine === wanted.afterLine &&
    live.bar === wanted.bar &&
    live.omitted === wanted.omitted &&
    live.rows.length === wanted.rows.length &&
    live.rows.every((row, index) => row === wanted.rows[index])
  );
}

/** The CodeLens groups for an editor showing `state`'s file, top to bottom. */
export function lensPlan(state: FileState): LensItem[] {
  if (state.pending === 0) return [];
  if (state.granularity === 'file') return [{ line: 0, text: FILE_TEXT[state.situation], block: undefined }];
  if (state.cur === null) return [];

  const lineCount = state.cur.lines.length;
  return state.blocks.map((block) => ({
    line: anchorLine(block, lineCount),
    text: state.situation === 'created' ? FILE_TEXT.created : blockLabel(block),
    block,
  }));
}

/** Lines added and removed, as in `+7 −3`. */
export interface LineStats {
  readonly added: number;
  readonly removed: number;
}

/**
 * How many lines a file's pending changes add and remove, counted as git counts them: a rewritten line is one
 * removed and one added. Undefined for a file that is only kept or discarded whole (binary, too large), which
 * has no lines to count.
 */
export function lineStats(state: FileState): LineStats | undefined {
  if (state.granularity !== 'blocks') return undefined;
  if (state.situation === 'created') return { added: linesIn(state.cur), removed: 0 };
  if (state.situation === 'deleted') return { added: 0, removed: linesIn(state.base) };

  let added = 0;
  let removed = 0;
  for (const block of state.blocks) {
    added += block.curEnd - block.curStart;
    removed += block.baseEnd - block.baseStart;
  }
  return { added, removed };
}

/** `stats` as shown beside a file, "+7 −3": a side with no lines is left out, and so is everything when neither has any. */
export function statsText({ added, removed }: LineStats): string {
  return [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter((part) => part !== '').join(' ');
}

/** The lines a file has; none when its text is not available. A created or deleted file is one block that spans its whole text. */
function linesIn(doc: Doc | null): number {
  return doc === null ? 0 : textLines(doc);
}

/**
 * Where a file is, for showing it in a list: inside one of the workspace
 * folders, `directory` is relative to the innermost one; outside them it is the
 * folder itself, starting from `~` when that is under home.
 */
export function locate(path: string, roots: readonly string[], home: string): { inside: boolean; directory: string } {
  const directory = dirname(path);
  const root = roots
    .map((candidate) => resolve(candidate))
    .filter((candidate) => isWithin(directory, candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (root !== undefined) return { inside: true, directory: relative(root, directory) };

  const homeDirectory = resolve(home);
  if (directory === homeDirectory) return { inside: false, directory: '~' };
  if (isWithin(directory, homeDirectory)) return { inside: false, directory: `~${sep}${relative(homeDirectory, directory)}` };
  return { inside: false, directory };
}

/** What a window does with a pending file: `here` lists it, `outside` lists it apart, `hidden` does not list it. */
export type Scope = 'here' | 'outside' | 'hidden';

/**
 * Whether a window with these folders lists a pending file. The store is shared by every window and
 * every project, so a window lists the files in its folders, and the files elsewhere that a Claude
 * session started in one of its folders (or inside one) changed. A session started above or beside
 * the folders does not count: that is another project's work, even when it touched a shared file.
 * With no folder open there is nothing to be outside of, so every file is here.
 * @param sessionDirs where the sessions that changed the file were started; empty for an entry made
 *   before they were recorded, which can only be judged by where the file is
 * @param roots the window's folders, in every spelling the store may know them by (see `workspaceRoots`)
 */
export function classify(path: string, sessionDirs: readonly string[], roots: readonly string[]): Scope {
  if (roots.length === 0) return 'here';
  const folders = roots.map((root) => resolve(root));
  if (folders.some((folder) => isWithin(dirname(path), folder))) return 'here';
  return sessionDirs.some((dir) => folders.some((folder) => isWithin(dir, folder))) ? 'outside' : 'hidden';
}

/** Whether `path` is `parent` or below it. A folder that merely starts with the same characters is not. */
function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Markdown for `lines` as a code block. The fence is longer than any run of
 * backticks in the text, so text that contains a fence cannot end the block
 * early and turn the rest into markup.
 */
export function fenced(lines: readonly string[], language: string): string {
  const longestRun = Math.max(0, ...lines.flatMap((line) => [...line.matchAll(/`+/g)].map((run) => run[0].length)));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  // The language is only a highlighting hint; whatever else it holds could end the opening line.
  const hint = language.replace(/[^\w.+#-]/g, '');
  return `${fence}${hint}\n${lines.join('\n')}\n${fence}`;
}

function excerpt(lines: readonly string[]): Excerpt {
  return {
    lines: lines.slice(0, MAX_EXCERPT_LINES).map((line) => line.slice(0, MAX_EXCERPT_LINE_LENGTH)),
    omitted: Math.max(0, lines.length - MAX_EXCERPT_LINES),
  };
}
