import {
  computeBlocks,
  createdFileBlocks,
  deletedFileBlocks,
  parseDoc,
  type Block,
  type Doc,
} from './hunks.ts';

/**
 * Larger files are only kept or discarded as a whole: diffing them line by
 * line costs more than a review of them is worth, and the pending view would
 * not be a useful place to read them anyway.
 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const BOM = String.fromCharCode(0xfeff);

/**
 * What a pending file looks like now, or nothing if the file is gone.
 * `text` is an open editor buffer, which VS Code has already decoded.
 */
export type Current = { readonly bytes: Uint8Array } | { readonly text: string } | null;

export interface FileState {
  /** How the file differs from its baseline: edited, created by Claude, or deleted since. */
  readonly situation: 'edited' | 'created' | 'deleted';
  /**
   * 'blocks' when each block can be kept or discarded on its own. 'file' for
   * what cannot be compared by line (binary, not UTF-8, notebooks, too large),
   * where only the whole file can be.
   */
  readonly granularity: 'blocks' | 'file';
  /** The baseline as text; null if there is none (a created file) or it is not text. */
  readonly base: Doc | null;
  /** The file now as text; null if it is missing or not text. */
  readonly cur: Doc | null;
  /** Whether the baseline began with a byte order mark, which VS Code buffers never show. */
  readonly bom: boolean;
  /** Empty unless `granularity` is 'blocks'. */
  readonly blocks: readonly Block[];
  /** How many things the user can still keep or discard here; 0 means the file matches its baseline. */
  readonly pending: number;
}

/**
 * @returns the text, or null if the bytes are not something to compare line
 * by line: not valid UTF-8, containing NUL (UTF-16 and binary formats do), or
 * too large.
 */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } | null {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

export function encodeText(text: string, bom: boolean): Buffer {
  return Buffer.from((bom ? BOM : '') + text, 'utf8');
}

/**
 * The baseline as text, or null when it is not to be compared line by line:
 * Claude created the file, or it is binary, not UTF-8, too large or a notebook.
 * Decides, with the same rules as `computeState`, whether blocks can exist.
 */
export function baselineText(path: string, baseline: Uint8Array | null): { text: string; bom: boolean } | null {
  return comparable(path) && baseline !== null ? decodeText(baseline) : null;
}

/** A notebook is JSON text, but editing it as lines would not keep it a notebook. */
function comparable(path: string): boolean {
  return !path.toLowerCase().endsWith('.ipynb');
}

export function computeState(input: {
  path: string;
  existed: boolean;
  /** The baseline bytes; null exactly when Claude created the file. */
  baseline: Uint8Array | null;
  current: Current;
}): FileState {
  const { path, existed, baseline, current } = input;
  const base = baselineText(path, baseline);
  const cur = current === null ? null : 'text' in current ? { text: current.text } : comparable(path) ? decodeText(current.bytes) : null;

  const wholeFile = (situation: FileState['situation'], pending: number): FileState => ({
    situation,
    granularity: 'file',
    base: null,
    cur: null,
    bom: false,
    blocks: [],
    pending,
  });
  const nothingPending = (situation: FileState['situation']): FileState => ({ ...wholeFile(situation, 0), granularity: 'blocks' });

  if (!existed) {
    if (current === null) return nothingPending('created');
    if (cur === null) return wholeFile('created', 1);
    const curDoc = parseDoc(cur.text);
    return { situation: 'created', granularity: 'blocks', base: null, cur: curDoc, bom: false, blocks: createdFileBlocks(curDoc), pending: 1 };
  }

  if (base === null) {
    if (current === null) return wholeFile('deleted', 1);
    return wholeFile('edited', sameBytes(baseline, current) ? 0 : 1);
  }

  const baseDoc = parseDoc(base.text);
  if (current === null) {
    return { situation: 'deleted', granularity: 'blocks', base: baseDoc, cur: null, bom: base.bom, blocks: deletedFileBlocks(baseDoc), pending: 1 };
  }
  if (cur === null) return { ...wholeFile('edited', 1), base: baseDoc, bom: base.bom };

  const curDoc = parseDoc(cur.text);
  const blocks = computeBlocks(baseDoc, curDoc);
  return { situation: 'edited', granularity: 'blocks', base: baseDoc, cur: curDoc, bom: base.bom, blocks, pending: blocks.length };
}

function sameBytes(baseline: Uint8Array | null, current: NonNullable<Current>): boolean {
  if (baseline === null) return false;
  const bytes = 'text' in current ? Buffer.from(current.text, 'utf8') : current.bytes;
  return Buffer.from(baseline).equals(bytes);
}
