import * as vscode from 'vscode';
import { openStore } from '../../claude-plugin/store.mjs';
import { PendingModel } from './pending.ts';
import { PendingCodeLenses } from './ui/codelens.ts';
import { registerCommands, realPrompts, type Prompts } from './ui/commands.ts';
import { ContextKeys } from './ui/context.ts';
import { Decorations } from './ui/decorations.ts';
import { BASELINE_SCHEME, BaselineContent } from './ui/diff.ts';
import { ExplorerMarks, registerMarks } from './ui/explorer.ts';
import { Follow } from './ui/follow.ts';
import { Insets } from './ui/insets.ts';
import { Summary } from './ui/status.ts';
import { PendingTree } from './ui/tree.ts';

/** What `activate` returns. Nothing else uses it; the integration tests drive the extension through it. */
export interface ExtensionApi {
  readonly model: PendingModel;
  readonly prompts: Prompts;
  readonly decorations: Decorations;
  readonly insets: Insets;
  readonly summary: Summary;
  readonly context: ContextKeys;
  readonly tree: PendingTree;
  readonly follow: Follow;
  readonly explorer: ExplorerMarks;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel('Clause');
  const model = new PendingModel(openStore(), (message) => output.appendLine(message));
  const prompts = realPrompts();

  // Before the decorations and lenses, so that a change reaches them after the insets have caught up with it.
  const insets = new Insets(model, (message) => output.appendLine(message));
  const decorations = new Decorations(model, insets);
  const lenses = new PendingCodeLenses(model, insets);
  const tree = new PendingTree(model);
  const view = vscode.window.createTreeView('claudePending', { treeDataProvider: tree, showCollapseAll: true });
  const summary = new Summary(model, view);
  const baselines = new BaselineContent(model);
  const follow = new Follow(model, (message) => output.appendLine(message));
  const explorer = new ExplorerMarks(model);
  const keys = new ContextKeys(model);

  context.subscriptions.push(
    output,
    model,
    insets,
    decorations,
    lenses,
    tree,
    view,
    summary,
    follow,
    explorer,
    keys,
    registerCommands(model, prompts),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    baselines,
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, baselines),
    registerMarks(explorer, (message) => output.appendLine(message)),
  );

  try {
    model.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    output.appendLine(`could not start: ${reason}`);
    void vscode.window.showErrorMessage(`Clause could not start: ${reason}`);
  }
  return { model, prompts, decorations, insets, summary, context: keys, tree, follow, explorer };
}

export function deactivate(): void {}
