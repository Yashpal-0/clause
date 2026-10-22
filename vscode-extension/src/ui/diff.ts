import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { PendingFile, PendingModel } from '../pending.ts';

export const BASELINE_SCHEME = 'clause';

/**
 * A document holding the file as it was before Claude, for the left side of
 * the diff editor. The path is the file's own so that the editor picks the
 * right language; the query says whose baseline it is, and is empty for the
 * empty side of a created or deleted file.
 */
function baselineUri(file: PendingFile, empty: boolean): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: file.uri.path, query: empty ? '' : file.id });
}

export class BaselineContent implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #model: PendingModel;
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;
  readonly #served = new Map<string, vscode.Uri>();
  readonly #subscription: vscode.Disposable;

  constructor(model: PendingModel) {
    this.#model = model;
    // Keeping a block changes the baseline, and the open diff has to follow.
    this.#subscription = model.onDidChange(() => {
      for (const uri of this.#served.values()) this.#changed.fire(uri);
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.#served.set(uri.toString(), uri);
    return uri.query === '' ? '' : (this.#model.baselineOf(uri.query) ?? '');
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changed.dispose();
  }
}

/** Opens the diff editor with the file as it was before Claude on the left and as it is now on the right. */
export async function openDiff(file: PendingFile): Promise<void> {
  if (file.state.granularity !== 'blocks') {
    void vscode.window.showInformationMessage(`${basename(file.path)} is not text that can be compared line by line, so there is no diff to show.`);
    return;
  }
  const before = baselineUri(file, file.state.situation === 'created');
  const after = file.state.situation === 'deleted' ? baselineUri(file, true) : file.uri;
  await vscode.commands.executeCommand('vscode.diff', before, after, `${basename(file.path)} (before Claude ↔ now)`, { preview: false });
}

/**
 * Opens one scrolling diff of `files`, in the order given, each with the file as it was before Claude on the left
 * and as it is now on the right. A file Claude created has an empty left side and one it deleted has no right side.
 * Files that cannot be compared line by line (binary, too large) are left out; resolves to how many it shows, and
 * opens nothing when that is none. It is for reading: the Keep and Discard bars are not drawn inside it.
 */
export async function openAllDiffs(files: readonly PendingFile[]): Promise<number> {
  // [the file the entry stands for, its left side, its right side], as `vscode.changes` takes them.
  const changes = files
    .filter((file) => file.state.granularity === 'blocks')
    .map((file) => [file.uri, baselineUri(file, file.state.situation === 'created'), file.state.situation === 'deleted' ? undefined : file.uri]);
  if (changes.length > 0) await vscode.commands.executeCommand('vscode.changes', 'Pending changes (before Claude ↔ now)', changes);
  return changes.length;
}
