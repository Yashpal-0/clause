import * as vscode from 'vscode';
import type { Block } from '../hunks.ts';
import { anchorLine, blockAfterSettled, blockAtLine, fileAfter, findBlock, nextBlock, partsToKeep, previousBlock, reviewOrder } from '../nav.ts';
import type { OpResult, PendingFile, PendingModel } from '../pending.ts';
import { asTarget } from '../targets.ts';
import { BASELINE_SCHEME, openAllDiffs, openDiff } from './diff.ts';
import { partition, visible } from './scope.ts';

/**
 * How long a kept or discarded change waits for the model to show the file without it before the cursor stays where
 * it is. The model learns of the new text a moment after the command is done, and it is usually quick; past this,
 * something is wrong that a cursor jump would not be worth waiting for.
 */
const GO_ON_WAIT_MS = 1000;

/** The questions the commands put to the user; a field is replaceable so that a test need not click a dialog. */
export interface Prompts {
  /** Asks before discarding in bulk; resolves true to go ahead. */
  confirmDiscard: (message: string, detail: string) => Thenable<boolean>;
}

export const realPrompts = (): Prompts => ({
  confirmDiscard: async (message, detail) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Discard')) === 'Discard',
});

/**
 * Registers the `clause.*` commands. Each takes the row, lens or
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

    // Only for the file being looked at: a click in the panel on another file leaves the editor where it is.
    const editor = activeEditor();
    const lookingAt = editor !== undefined && model.fileForUri(editor.document.uri)?.id === found.id;
    const result = report(await run(found.id, found.block));
    if (result.ok && lookingAt) await goOn(editor, found);
    return result;
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

  const moveTo = (editor: vscode.TextEditor, line: number) => {
    const position = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const jump = (pick: typeof nextBlock) => {
    const editor = activeEditor();
    const file = activeFile();
    if (editor === undefined || file === undefined || file.state.cur === null) return;
    const block = pick(file.state.blocks, editor.selection.active.line);
    if (block !== undefined) moveTo(editor, anchorLine(block, file.state.cur.lines.length));
  };

  /** Resolves true once `done()` holds, checked now and after every change of the model, or false after `ms`. */
  const modelShows = (done: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      const finish = (shown: boolean) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(shown);
      };
      const timer = setTimeout(() => finish(false), ms);
      const subscription = model.onDidChange(() => done() && finish(true));
      if (done()) finish(true);
    });

  /**
   * After a change is kept or discarded, puts the cursor on the next change of the file, as Cursor's review does, so
   * that Keep and Discard can be pressed again without moving. Waits for the model to show the file without the
   * settled change, then gives up and leaves the cursor: nothing here is worth holding the user up for.
   */
  const goOn = async (editor: vscode.TextEditor, settled: { id: string; block: Block }) => {
    const gone = () => {
      const file = model.fileById(settled.id);
      return file === undefined || findBlock(file.state.blocks, settled.block) === undefined;
    };
    if (!(await modelShows(gone, GO_ON_WAIT_MS))) return;

    const file = model.fileById(settled.id);
    // The user may have moved on to another editor while the model caught up.
    if (file === undefined || file.state.cur === null || vscode.window.activeTextEditor !== editor) return;
    const next = blockAfterSettled(file.state.blocks, settled.block.curStart, file.state.cur.lines.length);
    if (next !== undefined) moveTo(editor, anchorLine(next, file.state.cur.lines.length));
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
      await openForReview(file);
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

  const undo = async () => {
    const editor = activeEditor();
    const result = editor === undefined ? null : await model.undo(editor.document);
    // Nothing of Clause's to take back here, or a Discard, whose text the editor's own undo brings back.
    return result === null ? vscode.commands.executeCommand('undo') : report(result);
  };
  // One Ctrl+Z at a time: each must see the text the one before left, and a held key sends them faster than they finish.
  let undoing: Promise<unknown> = Promise.resolve();

  const register = (name: string, handler: (arg: unknown) => unknown) => vscode.commands.registerCommand(`clause.${name}`, handler);

  return vscode.Disposable.from(
    register('keepBlock', (arg) => onBlock(arg, (id, block) => model.keepBlock(id, block))),
    register('discardBlock', (arg) => onBlock(arg, (id, block) => model.discardBlock(id, block))),
    register('keepSelection', async () => {
      const editor = activeEditor();
      const file = activeFile();
      const parts = editor === undefined || file === undefined ? [] : partsToKeep(file.state, editor.selections);
      if (file === undefined || parts.length === 0) {
        return tell('Select some lines of a pending change first.');
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
    register('reviewAll', async () => {
      const files = reviewOrder(visible(model.files()));
      if (files.length === 0) return tell('Nothing is pending.');

      try {
        if ((await openAllDiffs(files)) === 0) return tell('None of the pending files is text that can be compared line by line.');
      } catch (error) {
        // `vscode.changes` is an editor command with no entry in the extension API, so an editor update can drop it.
        void vscode.window.showWarningMessage(`Could not open the combined diff: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    register('nextBlock', () => jump(nextBlock)),
    register('previousBlock', () => jump(previousBlock)),
    register('nextFile', () => stepFile(1)),
    register('previousFile', () => stepFile(-1)),
    register('reveal', reveal),
    register('refresh', () => model.refreshAll()),
    register('undo', () => (undoing = undoing.then(undo, undo))),
  );
}
