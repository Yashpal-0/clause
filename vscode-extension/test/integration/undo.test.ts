import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import type { PendingTouch } from '../../src/pending.ts';
import { extensionApi, hasEntry, onlyPendingFile, open, pendingAt, reset, seedCreated, seedEdited, sleep, store, storedBaseline, waitFor, workspaceDir } from './helpers.ts';

// Claude rewrote "two" as two lines (a block at lines 1-2, zero-based) and added "six" (a block at line 6).
const BEFORE = 'one\ntwo\nthree\nfour\nfive\n';
const AFTER = 'one\n2a\n2b\nthree\nfour\nfive\nsix\n';

const KEY = 'clause.canUndo';

describe('Ctrl+Z after a Keep or a Discard', () => {
  let api: ExtensionApi;
  const warnings: string[] = [];
  const realWarn = vscode.window.showWarningMessage;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    warnings.length = 0;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
  });
  afterEach(async () => {
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = realWarn;
    await reset(api);
  });

  async function openChanged(after = AFTER): Promise<{ path: string; editor: vscode.TextEditor }> {
    const path = seedEdited('a.txt', BEFORE, after, workspaceDir());
    await onlyPendingFile(api);
    return { path, editor: await open(path) };
  }

  const undo = () => vscode.commands.executeCommand('clause.undo');
  const blockCount = (path: string) => pendingAt(api, path)?.state.blocks.length ?? 0;

  /** Keeps the first block, with the cursor in it as for Ctrl+Y, and waits for it to be gone. */
  async function keepFirstBlock(path: string, editor: vscode.TextEditor): Promise<void> {
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('clause.keepBlock');
    await waitFor('the block to be kept', () => blockCount(path) === 1);
  }

  it('takes back a kept block: the baseline and the block are as they were, and the text is not touched', async () => {
    const { path, editor } = await openChanged();
    await keepFirstBlock(path, editor);

    await undo();

    assert.equal(storedBaseline(path), BEFORE);
    await waitFor('the block to be back', () => blockCount(path) === 2);
    assert.equal(editor.document.getText(), AFTER);
    assert.deepEqual(warnings, []);
  });

  it('takes back kept lines', async () => {
    const { path, editor } = await openChanged();
    editor.selection = new vscode.Selection(2, 0, 3, 0);
    await vscode.commands.executeCommand('clause.keepSelection');
    assert.notEqual(storedBaseline(path), BEFORE);

    await undo();

    assert.equal(storedBaseline(path), BEFORE);
    await waitFor('the change to be whole again', () => pendingAt(api, path)?.state.blocks[0]?.curEnd === 3);
  });

  it('takes back the Keep that settled the file: the entry is back as it was, sessions and all', async () => {
    const { path, editor } = await openChanged();
    const id = store().idFor(path);
    const before = store().readEntry(id);
    assert.ok(before);

    await vscode.commands.executeCommand('clause.keepFile');
    await waitFor('the file to be settled', () => api.model.files().length === 0);
    assert.equal(hasEntry(path), false);
    const touches: PendingTouch[] = [];
    const listening = api.model.onDidTouch((touch) => touches.push(touch));
    try {
      await undo();

      const after = store().readEntry(id);
      assert.equal(after?.createdAt, before.createdAt);
      assert.deepEqual(after?.sessionDirs, [workspaceDir()]);
      assert.equal(after?.base?.toString('utf8'), BEFORE);
      await waitFor('both blocks to be back', () => blockCount(path) === 2);
      assert.equal(editor.document.getText(), AFTER);
      // Long enough for the store's event about the entry to be handled.
      await sleep(300);
      assert.deepEqual(touches, [], 'not taken for a new edit of Claude\'s, which Follow would open');
    } finally {
      listening.dispose();
    }
  });

  it('takes back keeping some or all of a file Claude created, which counts as created again', async () => {
    const path = seedCreated('new.txt', 'a\nb\nc\n');
    await onlyPendingFile(api);
    const editor = await open(path);
    const created = () => pendingAt(api, path)?.state.situation === 'created' && store().readMeta(store().idFor(path))?.existed === false;

    editor.selection = new vscode.Selection(1, 0, 2, 0);
    await vscode.commands.executeCommand('clause.keepSelection');
    await waitFor('the file to count as one that existed', () => pendingAt(api, path)?.state.situation === 'edited');
    await undo();
    await waitFor('the file to count as created again', created);
    assert.equal(storedBaseline(path), undefined, 'and to have no baseline');

    await vscode.commands.executeCommand('clause.keepFile');
    await waitFor('the file to be settled', () => api.model.files().length === 0);
    await undo();
    await waitFor('the file to be pending again, as created', created);
  });

  it('takes back typing first and then the Keep before it, as one undo history would', async () => {
    const { path, editor } = await openChanged();
    await keepFirstBlock(path, editor);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'typed '));

    await undo();
    assert.equal(editor.document.getText(), AFTER, 'the typing is gone');
    assert.notEqual(storedBaseline(path), BEFORE, 'the Keep is not, yet');

    await undo();
    assert.equal(storedBaseline(path), BEFORE);
    await waitFor('both blocks to be back', () => blockCount(path) === 2);
  });

  it('takes back both when Ctrl+Z is pressed twice faster than the first one finishes, as a held key does', async () => {
    const { path, editor } = await openChanged();
    await keepFirstBlock(path, editor);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'typed '));

    await Promise.all([undo(), undo()]);

    assert.equal(editor.document.getText(), AFTER);
    assert.equal(storedBaseline(path), BEFORE);
  });

  it('takes back a Discard that settled the file: the entry comes back with the text, which is pending again', async () => {
    const ONE_CHANGE = 'one\nTWO\nthree\nfour\nfive\n';
    const { path, editor } = await openChanged(ONE_CHANGE);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('clause.discardBlock');
    await waitFor('the file to be settled', () => api.model.files().length === 0 && !hasEntry(path));
    assert.equal(editor.document.getText(), BEFORE);
    await waitFor('the key to turn on, though nothing is pending', () => api.context.value(KEY) === true);

    await undo();

    assert.equal(editor.document.getText(), ONE_CHANGE);
    assert.equal(storedBaseline(path), BEFORE);
    await waitFor('the change to be pending again', () => blockCount(path) === 1);
    // The context key is read by the key that sends Ctrl+Z here; it must not wait for a later change to turn off.
    await waitFor('the key to turn off', () => api.context.value(KEY) === false);
  });

  it('is the editor\'s own undo in a file with nothing of Clause\'s to take back', async () => {
    const { path, editor } = await openChanged();
    // On a line of its own, away from both blocks, typing is a block of its own.
    await editor.edit((edit) => edit.insert(new vscode.Position(4, 0), 'typed '));
    await waitFor('the typing to be pending', () => blockCount(path) === 3);

    await undo();

    assert.equal(editor.document.getText(), AFTER);
    await waitFor('the typing to be gone', () => blockCount(path) === 2);
  });

  it('says so, and changes nothing, when what is pending changed in another window since the Keep', async () => {
    const { path, editor } = await openChanged();
    await keepFirstBlock(path, editor);
    const elsewhere = 'one\n2a\n2b\nthree\nFOUR\nfive\n';
    assert.ok(store().writeBase(store().idFor(path), Buffer.from(elsewhere)));
    await waitFor('the other window\'s Keep to show', () => pendingAt(api, path)?.state.blocks.some((block) => block.kind === 'changed') === true);

    await undo();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Could not undo/);
    assert.equal(storedBaseline(path), elsewhere);
  });

  it('turns on the context key in the file that has something to take back, and off in another and once it is taken back', async () => {
    const { path, editor } = await openChanged();
    const other = seedEdited('b.txt', BEFORE, AFTER);
    await waitFor('both files to be pending', () => api.model.files().length === 2);
    assert.equal(api.context.value(KEY), false);

    await keepFirstBlock(path, editor);
    await waitFor('the key to turn on', () => api.context.value(KEY) === true);
    await open(other);
    await waitFor('the key to turn off in the other file', () => api.context.value(KEY) === false);
    await open(path);
    await waitFor('the key to turn on again', () => api.context.value(KEY) === true);

    await undo();
    await waitFor('the key to turn off once the Keep is taken back', () => api.context.value(KEY) === false);
  });
});
