import * as vscode from 'vscode';
import type { Block } from '../hunks.ts';
import { anchorLine, blockAtLine, fileAfter, nextBlock, partsToKeep, previousBlock, reviewOrder } from '../nav.ts';
import type { OpResult, PendingFile, PendingModel } from '../pending.ts';
import { asTarget } from '../targets.ts';
import { BASELINE_SCHEME, openDiff } from './diff.ts';
import { partition, visible } from './scope.ts';

/** The questions the commands put to the user; a field is replaceable so that a test need not click a dialog. */
export interface Prompts {
  /** Asks before discarding in bulk; resolves true to go ahead. */
  confirmDiscard: (message: string, detail: string) => Thenable<boolean>;
}

export const realPrompts = (): Prompts => ({
  confirmDiscard: async (message, detail) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Discard')) === 'Discard',
});

/**
 * Registers the `claudePending.*` commands. Each takes the row, lens or
 * resource it was invoked from, or acts on the active editor's cursor when it
 * is invoked without one (keybindings, the palette), and resolves to what the
 * model reported.
 */
export function registerCommands(model: PendingModel, prompts: Prompts): vscode.Disposable {
  const activeEditor = () => vscode.window.activeTextEditor;
  const activeFile = (): PendingFile | undefined => {
    const editor = activeEditor();
    return editor === undefined ? undefined : model.fileForUri(editor.document.uri);
  };

  /** The file the command was meant for: the row or resource it was called on, else the active editor's. */
  const fileFrom = (arg: unknown): PendingFile | undefined => {
    if (arg instanceof vscode.Uri) return model.fileForUri(arg);
    const target = asTarget(arg);
    if (target === undefined) return activeFile();
    return target.kind === 'group' ? undefined : model.fileById(target.id);
  };

  /** The block the command was meant for: the lens or row it was called on, else the one under the cursor. */
  const blockFrom = (arg: unknown): { id: string; block: Block } | undefined => {
    const target = asTarget(arg);
    if (target?.kind === 'block') return { id: target.id, block: target.block };
    if (target !== undefined) return undefined;

    const editor = activeEditor();
    const file = activeFile();
    const block = editor === undefined || file === undefined ? undefined : blockAtLine(file.state.blocks, editor.selection.active.line);
    return file !== undefined && block !== undefined ? { id: file.id, block } : undefined;
  };

  const tell = (message: string): undefined => {
    void vscode.window.showInformationMessage(message);
    return undefined;
  };
  const report = (result: OpResult): OpResult => {
    if (!result.ok) void vscode.window.showWarningMessage(result.reason);
    return result;
  };

  const onBlock = async (arg: unknown, run: (id: string, block: Block) => Promise<OpResult>) => {
    const found = blockFrom(arg);
    if (found === undefined) return tell('Put the cursor in a pending change first, or keep or discard the whole file.');
    return report(await run(found.id, found.block));
  };

  const onFile = async (arg: unknown, run: (file: PendingFile) => Promise<OpResult>) => {
    const file = fileFrom(arg);
    if (file === undefined) return tell('This file has no pending changes.');
    return report(await run(file));
  };

  /** Everything in this window's folders, or only the files outside them that its sessions changed when called on that group. */
  const filesIn = (arg: unknown): PendingFile[] => {
    const { here, outside } = partition(model.files());
    return asTarget(arg)?.kind === 'group' ? outside : here;
  };

  const jump = (pick: typeof nextBlock) => {
    const editor = activeEditor();
    const file = activeFile();
    if (editor === undefined || file === undefined || file.state.cur === null) return;
    const block = pick(file.state.blocks, editor.selection.active.line);
    if (block === undefined) return;

    const line = Math.min(anchorLine(block, file.state.cur.lines.length), editor.document.lineCount - 1);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const reveal = async (arg: unknown) => {
    const target = asTarget(arg);
    if (target === undefined || target.kind === 'group') return;
    const file = model.fileById(target.id);
    if (file === undefined) return;

    // A file that is gone has nothing to open; its diff shows what was removed.
    if (file.state.situation === 'deleted') return openDiff(file);
    if (target.kind === 'block' && file.state.cur !== null) {
      const position = new vscode.Position(anchorLine(target.block, file.state.cur.lines.length), 0);
      await vscode.window.showTextDocument(file.uri, { preview: false, selection: new vscode.Range(position, position) });
    } else {
      await vscode.commands.executeCommand('vscode.open', file.uri);
    }
  };

  /**
   * The pending file the active tab shows. The active text editor is not enough: the tab of a file that is
   * gone is a diff whose sides are baselines, and walking on from it has to know where it is in the order.
   */
  const shownFile = (): PendingFile | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText) return model.fileForUri(input.uri);
    if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
    return model.fileForUri(input.modified) ?? (input.original.scheme === BASELINE_SCHEME ? model.fileById(input.original.query) : undefined);
  };

  /**
   * Opens `file` the way a review walks through files: in a preview tab, so that going through many leaves one
   * tab, with the cursor on its first change and the text focused, so that Keep and Discard work at once.
   */
  const openForReview = async (file: PendingFile) => {
    // A file that is gone has nothing to open; its diff shows what was removed.
    if (file.state.situation === 'deleted') return openDiff(file);

    const first = file.state.blocks[0];
    if (first === undefined || file.state.cur === null) {
      // No lines to put a cursor on (binary, too large): whatever editor suits the file.
      await vscode.commands.executeCommand('vscode.open', file.uri, { preview: true });
      return;
    }
    const position = new vscode.Position(anchorLine(first, file.state.cur.lines.length), 0);
    await vscode.window.showTextDocument(file.uri, { preview: true, selection: new vscode.Range(position, position) });
  };

  /** Goes `step` files on in review order, among the files this window lists. */
  const stepFile = async (step: 1 | -1) => {
    const order = reviewOrder(visible(model.files()));
    if (order.length === 0) return tell('Nothing is pending.');

    const current = shownFile();
    if (order.length === 1 && order[0]?.id === current?.id) return tell('This is the only file with pending changes.');

    const next = fileAfter(order, current?.id, step);
    if (next !== undefined) await openForReview(next);
  };

  const register = (name: string, handler: (arg: unknown) => unknown) => vscode.commands.registerCommand(`claudePending.${name}`, handler);

  return vscode.Disposable.from(
    register('keepBlock', (arg) => onBlock(arg, (id, block) => model.keepBlock(id, block))),
    register('discardBlock', (arg) => onBlock(arg, (id, block) => model.discardBlock(id, block))),
    register('keepSelection', async () => {
      const editor = activeEditor();
      const file = activeFile();
      const parts = editor === undefined || file === undefined ? [] : partsToKeep(file.state, editor.selections);
      if (file === undefined || parts.length === 0) {
        return tell('Select some lines of a pending change first. A file Claude created can only be kept whole.');
      }
      return report(await model.keepParts(file.id, parts));
    }),
    register('keepFile', (arg) => onFile(arg, (file) => model.keepFile(file.id))),
    register('discardFile', (arg) => onFile(arg, (file) => model.discardFile(file.id))),
    register('keepAll', async (arg) => {
      const files = filesIn(arg);
      return files.length === 0 ? tell('Nothing is pending.') : report(await model.keepFiles(files.map((file) => file.id)));
    }),
    register('discardAll', async (arg) => {
      const files = filesIn(arg);
      if (files.length === 0) return tell('Nothing is pending.');

      const changes = files.reduce((sum, file) => sum + file.state.pending, 0);
      const created = files.filter((file) => file.state.situation === 'created').length;
      const detail = [
        `${changes} ${changes === 1 ? 'change' : 'changes'} will be reverted.`,
        created > 0 ? `${created} ${created === 1 ? 'file' : 'files'} Claude created will be moved to the trash.` : '',
      ]
        .filter((line) => line !== '')
        .join(' ');
      const message = `Discard pending changes in ${files.length} ${files.length === 1 ? 'file' : 'files'}?`;
      return (await prompts.confirmDiscard(message, detail)) ? report(await model.discardFiles(files.map((file) => file.id))) : undefined;
    }),
    register('openDiff', (arg) => onFile(arg, async (file) => (await openDiff(file), { ok: true }))),
    register('nextBlock', () => jump(nextBlock)),
    register('previousBlock', () => jump(previousBlock)),
    register('nextFile', () => stepFile(1)),
    register('previousFile', () => stepFile(-1)),
    register('reveal', reveal),
    register('refresh', () => model.refreshAll()),
  );
}
