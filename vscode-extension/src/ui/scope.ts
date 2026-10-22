import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { PendingFile, PendingModel } from '../pending.ts';
import { classify, locate } from '../present.ts';

/**
 * The folders open in the window, under the path they were opened with and
 * under their real path: the store records real paths, and a folder opened
 * through a symlink would otherwise not contain its own files.
 */
function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).flatMap(({ uri }) => {
    if (uri.scheme !== 'file') return [];
    try {
      return [uri.fsPath, realpathSync.native(uri.fsPath)];
    } catch {
      return [uri.fsPath];
    }
  });
}

/** Where `file` is, relative to the window's folders. */
export function whereIs(file: PendingFile): { inside: boolean; directory: string } {
  return locate(file.path, workspaceRoots(), homedir());
}

/**
 * Splits the pending files this window lists (see `classify`) into those in its
 * folders and those outside them that its sessions changed. The store is shared
 * by every window, so the rest are other projects' files; they are in neither
 * list and stay pending for the window that belongs to them.
 */
export function partition(files: readonly PendingFile[]): { here: PendingFile[]; outside: PendingFile[] } {
  const roots = workspaceRoots();
  const here: PendingFile[] = [];
  const outside: PendingFile[] = [];
  for (const file of files) {
    const scope = classify(file.path, file.sessionDirs, roots);
    if (scope === 'here') here.push(file);
    else if (scope === 'outside') outside.push(file);
  }
  return { here, outside };
}

/** The files this window lists, in the order given. */
export function visible(files: readonly PendingFile[]): PendingFile[] {
  const roots = workspaceRoots();
  return files.filter((file) => classify(file.path, file.sessionDirs, roots) !== 'hidden');
}

/** What the status bar, the badge and the view's visibility count: the files this window lists, not the whole store. */
export function scopedCounts(model: PendingModel): { pending: number; files: number } {
  return model.counts(visible(model.files()));
}
