import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { partsToKeep } from '../../src/nav.ts';
import { extensionApi, hasEntry, onlyPendingFile, open, pendingAt, read, reset, seedCreated, seedEdited, sleep, storedBaseline, waitFor } from './helpers.ts';

// Claude replaced "two" and "three" with four lines of its own (a block at lines 1-4, zero-based) and added "six"
// at the end (a block at line 7).
const BEFORE = 'one\ntwo\nthree\nfour\nfive\n';
const AFTER = 'one\n2a\n2b\n2c\n2d\nfour\nfive\nsix\n';

const KEY = 'clause.selectionInPending';

describe('keeping the selected lines of a change', () => {
  let api: ExtensionApi;
  const messages: string[] = [];
  const realTell = vscode.window.showInformationMessage;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    messages.length = 0;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    };
  });
  afterEach(async () => {
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = realTell;
    await reset(api);
  });

  async function openChanged(): Promise<{ path: string; editor: vscode.TextEditor }> {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    return { path, editor: await open(path) };
  }

  /** The pending blocks of the file as what they remove and add, which says what is left to decide. */
  const left = (path: string) => {
    const state = pendingAt(api, path)?.state;
    assert.ok(state?.base && state.cur, 'the file is pending as text');
    return state.blocks.map((block) => ({
      removed: state.base!.lines.slice(block.baseStart, block.baseEnd),
      added: state.cur!.lines.slice(block.curStart, block.curEnd),
    }));
  };

  it('puts only the selected lines in the baseline and leaves the rest of the block pending', async () => {
    const { path, editor } = await openChanged();
    editor.selection = new vscode.Selection(2, 0, 4, 0);

    await vscode.commands.executeCommand('clause.keepSelection');

    assert.equal(storedBaseline(path), 'one\ntwo\nthree\n2b\n2c\nfour\nfive\n');
    await waitFor('the block to shrink', () => pendingAt(api, path)?.state.blocks.length === 3);
    assert.deepEqual(left(path), [
      { removed: ['two', 'three'], added: ['2a'] },
      { removed: [], added: ['2d'] },
      { removed: [], added: ['six'] },
    ]);
    assert.equal(read(path), AFTER, 'the file itself is not touched');
  });

  it('takes in the lines of several changes when the selection runs across them', async () => {
    const { path, editor } = await openChanged();
    editor.selection = new vscode.Selection(3, 1, 7, 2);

    await vscode.commands.executeCommand('clause.keepSelection');

    await waitFor('the changes to shrink', () => left(path).length === 1);
    assert.deepEqual(left(path), [{ removed: ['two', 'three'], added: ['2a', '2b'] }]);
  });

  it('keeps a whole change when every line of it is selected, and the file when that was all that was left', async () => {
    const { path, editor } = await openChanged();

    editor.selection = new vscode.Selection(1, 0, 5, 0);
    await vscode.commands.executeCommand('clause.keepSelection');
    await waitFor('the first change to be gone', () => left(path).length === 1);
    assert.equal(storedBaseline(path), 'one\n2a\n2b\n2c\n2d\nfour\nfive\n');

    editor.selection = new vscode.Selection(0, 0, 8, 0);
    await vscode.commands.executeCommand('clause.keepSelection');
    // At once, not after the delay with which the model forgets a file that looks decided.
    assert.equal(hasEntry(path), false);
    await waitFor('the file to be settled', () => api.model.files().length === 0);
    assert.equal(read(path), AFTER);
  });

  it('counts what is kept from the text as it is in the editor, unsaved changes included', async () => {
    const { path, editor } = await openChanged();
    await editor.edit((edit) => edit.replace(new vscode.Range(2, 0, 2, 2), 'mine'));
    await waitFor('the edit to show as part of the change', () => left(path)[0]?.added.includes('mine') === true);

    editor.selection = new vscode.Selection(2, 0, 3, 0);
    await vscode.commands.executeCommand('clause.keepSelection');

    assert.equal(storedBaseline(path), 'one\ntwo\nthree\nmine\nfour\nfive\n');
    assert.equal(read(path), AFTER, 'nothing was saved by keeping');
  });

  it('tells the user, and keeps nothing, when the selection takes in no pending line', async () => {
    const { path, editor } = await openChanged();

    editor.selection = new vscode.Selection(0, 0, 1, 0);
    await vscode.commands.executeCommand('clause.keepSelection');
    editor.selection = new vscode.Selection(2, 1, 2, 1);
    await vscode.commands.executeCommand('clause.keepSelection');

    assert.equal(messages.length, 2);
    assert.match(messages[0]!, /Select some lines of a pending change/);
    assert.equal(storedBaseline(path), BEFORE);
  });

  it('cannot pick lines of a file Claude created, which is kept or discarded whole', async () => {
    const path = seedCreated('new.txt', 'a\nb\nc\n');
    await onlyPendingFile(api);
    const editor = await open(path);
    editor.selection = new vscode.Selection(0, 0, 2, 0);

    await vscode.commands.executeCommand('clause.keepSelection');

    assert.equal(messages.length, 1);
    assert.equal(hasEntry(path), true);
    await sleep(100);
    assert.equal(api.context.value(KEY), false);
  });

  it('refuses when the file changed after the lines were picked, so that other lines are not kept', async () => {
    const { path, editor } = await openChanged();
    const file = pendingAt(api, path)!;
    editor.selection = new vscode.Selection(2, 0, 3, 0);
    const parts = partsToKeep(file.state, editor.selections);
    assert.equal(parts.length, 1);

    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'a new first line\n'));
    await waitFor('the changed block to move down', () => pendingAt(api, path)?.state.blocks.some((block) => block.kind === 'changed' && block.curStart === 2) === true);
    const result = await api.model.keepParts(file.id, parts);

    assert.equal(result.ok, false);
    assert.equal(storedBaseline(path), BEFORE);
  });

  describe('the context key that tells a keybinding there is a selection to keep', () => {
    it('is on while the selection covers pending lines, and off for a cursor, other lines, and another file', async () => {
      const { editor } = await openChanged();
      const on = () => api.context.value(KEY);

      editor.selection = new vscode.Selection(2, 0, 3, 0);
      await waitFor('the key to turn on', () => on() === true);

      editor.selection = new vscode.Selection(2, 1, 2, 1);
      await waitFor('the key to turn off for a cursor', () => on() === false);

      editor.selection = new vscode.Selection(0, 0, 1, 0);
      await sleep(100);
      assert.equal(on(), false, 'unchanged lines');

      editor.selection = new vscode.Selection(2, 0, 3, 0);
      await waitFor('the key to turn on again', () => on() === true);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor('the key to turn off with no editor', () => on() === false);
    });

    it('turns off once the selected lines are kept', async () => {
      const { editor } = await openChanged();
      editor.selection = new vscode.Selection(2, 0, 3, 0);
      await waitFor('the key to turn on', () => api.context.value(KEY) === true);

      await vscode.commands.executeCommand('clause.keepSelection');

      await waitFor('the key to turn off', () => api.context.value(KEY) === false);
    });
  });
});
