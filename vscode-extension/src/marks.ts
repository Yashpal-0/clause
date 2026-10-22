import { dirname, sep } from 'node:path';

/**
 * The badge of a file that has changes waiting. VS Code merges the decorations
 * of every provider for one file into a single label colour, and git's can win;
 * a shape cannot be outvoted. Git's badges are letters (U, M, A, D) and the
 * Problems view's are digits, so a symbol that is neither stays readable beside both.
 */
export const MARKER_BADGE = '◆';

/**
 * The most files VS Code's extension host passes on from one announcement. It
 * keeps the shallowest 250 of a longer list and drops the rest, which then keep
 * a stale mark, so anything longer has to be announced as "everything".
 */
export const MAX_URIS_PER_EVENT = 250;

export function markerTooltip(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} waiting for Keep or Discard`;
}

/**
 * The folders that hold a file with changes waiting, each with how many such
 * files are below it, from the file's own folder up to the workspace folder that
 * contains it. Files outside every workspace folder add nothing: the file tree
 * does not show the folders above or beside the workspace folders.
 *
 * Every one of these folders needs a decoration of its own. VS Code builds a
 * folder's label from the folder's own decorations first and only then from
 * the ones its children pass up, and the first colour it meets wins, so a
 * folder that is not decorated itself is coloured by whichever provider
 * answered about a child first, which may be git.
 */
export function folderMarks(files: Iterable<string>, roots: readonly string[]): Map<string, number> {
  const prefixes = roots.map((root) => (root.endsWith(sep) ? root : root + sep));
  const inside = (folder: string) => roots.some((root, index) => folder === root || folder.startsWith(prefixes[index]!));

  const marks = new Map<string, number>();
  for (const file of files) {
    let folder = dirname(file);
    while (inside(folder)) {
      marks.set(folder, (marks.get(folder) ?? 0) + 1);
      const parent = dirname(folder);
      // The top of a file system is its own parent.
      if (parent === folder) break;
      folder = parent;
    }
  }
  return marks;
}

/**
 * The files and folders whose mark differs between two snapshots of how many
 * changes (or, for a folder, files) each has waiting: a new one, a different
 * count, one that is gone. `undefined` when there are more than one
 * announcement can list.
 */
export function changedMarks(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): string[] | undefined {
  const changed: string[] = [];
  for (const [path, count] of after) {
    if (before.get(path) !== count) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path);
  }
  return changed.length > MAX_URIS_PER_EVENT ? undefined : changed;
}
