import * as vscode from 'vscode';
import type { PendingModel } from '../pending.ts';
import { extractSelectionPayload, type IdeSelectionPayload } from '../nav.ts';
export { extractSelectionPayload, type IdeSelectionPayload };

/**
 * Bridges the user's active editor selection into Clause's local store so connected
 * CLI agents (like OMP) can reflect the selection in their TUI and turns.
 */
export class EditorSelectionBridge implements vscode.Disposable {
  readonly #model: PendingModel;
  readonly #subscriptions: vscode.Disposable[] = [];
  #debounceTimer: NodeJS.Timeout | undefined;
  #lastPublishedFolder: string | undefined;

  constructor(model: PendingModel, debounceMs: number = 80) {
    this.#model = model;
    this.#subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.#schedule(event.textEditor, debounceMs);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.#schedule(editor, debounceMs);
      }),
    );
  }

  #schedule(editor: vscode.TextEditor | undefined, debounceMs: number): void {
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#publish(editor);
    }, debounceMs);
  }

  #publish(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.#clear();
      return;
    }
    const text = editor.document.getText(editor.selection);
    const payload = extractSelectionPayload(editor.selection, editor.document.uri.fsPath, text);
    if (payload === null) {
      this.#clear();
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const folderPath = folder ? folder.uri.fsPath : undefined;
    if (!folderPath) {
      this.#clear();
      return;
    }

    if (this.#lastPublishedFolder !== undefined && this.#lastPublishedFolder !== folderPath) {
      this.#model.store.clearSelection(this.#lastPublishedFolder);
    }
    this.#lastPublishedFolder = folderPath;
    this.#model.store.writeSelection(folderPath, payload);
  }

  #clear(): void {
    if (this.#lastPublishedFolder !== undefined) {
      this.#model.store.clearSelection(this.#lastPublishedFolder);
      this.#lastPublishedFolder = undefined;
    }
  }

  dispose(): void {
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
    this.#clear();
    for (const sub of this.#subscriptions) {
      sub.dispose();
    }
  }
}
