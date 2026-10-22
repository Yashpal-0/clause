import * as vscode from 'vscode';
import { blockAtLine, partsToKeep } from '../nav.ts';
import type { PendingModel } from '../pending.ts';
import { scopedCounts } from './scope.ts';

/**
 * The context keys that `when` clauses of menus and keybindings read:
 * `clause.hasPending` (the window lists something, see `scopedCounts`),
 * `clause.fileHasPending` (the active editor's file),
 * `clause.inBlock` (the cursor is in a block) and
 * `clause.selectionInPending` (the selected lines include pending ones that can be kept on their own).
 */
export class ContextKeys implements vscode.Disposable {
  readonly #model: PendingModel;
  /** setContext is a command round trip; most updates change nothing. */
  readonly #values = new Map<string, boolean>();
  readonly #subscriptions: vscode.Disposable[];

  constructor(model: PendingModel) {
    this.#model = model;
    this.#subscriptions = [
      model.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) this.update();
      }),
    ];
    this.update();
  }

  /** The value last set for `key`, or undefined if never set, for tests: the editor does not let an extension read a context key back. */
  value(key: string): boolean | undefined {
    return this.#values.get(key);
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    const file = editor === undefined ? undefined : this.#model.fileForUri(editor.document.uri);
    this.#set('clause.hasPending', scopedCounts(this.#model).pending > 0);
    this.#set('clause.fileHasPending', file !== undefined);
    this.#set('clause.inBlock', editor !== undefined && file !== undefined && blockAtLine(file.state.blocks, editor.selection.active.line) !== undefined);
    this.#set('clause.selectionInPending', editor !== undefined && file !== undefined && partsToKeep(file.state, editor.selections).length > 0);
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
  }

  #set(key: string, value: boolean): void {
    if (this.#values.get(key) === value) return;
    this.#values.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
