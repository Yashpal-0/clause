import type { Block } from './hunks.ts';

/**
 * What a command is aimed at, as CodeLens, tree rows and menus pass it. A block
 * carries the coordinates it had when it was shown, which is how a command can
 * tell that the file has changed since.
 */
export interface BlockTarget {
  readonly kind: 'block';
  readonly id: string;
  readonly block: Block;
}

export interface FileTarget {
  readonly kind: 'file';
  readonly id: string;
}

/** The files outside the folders open in the window that Claude sessions started in them changed. */
export interface GroupTarget {
  readonly kind: 'group';
}

export type Target = BlockTarget | FileTarget | GroupTarget;

const BLOCK_KINDS: readonly string[] = ['added', 'removed', 'changed'];

/**
 * The target a command argument stands for, rebuilt from only the fields that
 * belong to it. Commands can be called by keybindings and other extensions
 * with anything, so the argument is checked before it is believed.
 */
export function asTarget(value: unknown): Target | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'group') return { kind: 'group' };
  if (!('id' in value) || typeof value.id !== 'string' || value.id === '') return undefined;
  if (value.kind === 'file') return { kind: 'file', id: value.id };
  if (value.kind === 'block' && 'block' in value) {
    const block = asBlock(value.block);
    return block === undefined ? undefined : { kind: 'block', id: value.id, block };
  }
  return undefined;
}

function asBlock(value: unknown): Block | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, baseStart, baseEnd, curStart, curEnd } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !BLOCK_KINDS.includes(kind)) return undefined;
  const base = lineRange(baseStart, baseEnd);
  const cur = lineRange(curStart, curEnd);
  if (base === undefined || cur === undefined) return undefined;
  return { kind: kind as Block['kind'], baseStart: base[0], baseEnd: base[1], curStart: cur[0], curEnd: cur[1] };
}

/** An end-exclusive range of line indexes: whole numbers, not negative, not backwards. */
function lineRange(start: unknown, end: unknown): [start: number, end: number] | undefined {
  const valid = typeof start === 'number' && typeof end === 'number' && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start;
  return valid ? [start, end] : undefined;
}
