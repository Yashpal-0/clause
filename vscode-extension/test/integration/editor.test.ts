import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { PendingModel } from '../../src/pending.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, hasEntry, onlyPendingFile, open, read, reset, seedEdited, sleep, store, storedBaseline, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// Claude changed line 2 only. Lines 3 and 4 separate it from line 5, so typing on line 5 is not next to its block
// (typing on a line beside a changed line grows that block instead of making a new one).
const WIDE_BEFORE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
const WIDE_AFTER = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n';

describe('reviewing a file that is open in an editor', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const kinds = () => api.model.files()[0]?.state.blocks.map((block) => block.kind);
  const typeAt = (editor: vscode.TextEditor, line: number) => editor.edit((edit) => edit.insert(new vscode.Position(line, 0), 'my '));

  it('discards through the editor, saves it, and Ctrl+Z brings the block back', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const editor = await open(path);

    const result = await vscode.commands.executeCommand('clause.discardBlock', blockTarget(file, 1));

    assert.deepEqual(result, { ok: true });
    assert.equal(editor.document.getText(), 'one\nTWO\nthree\nfour\n');
    assert.equal(editor.document.isDirty, false);
    assert.equal(read(path), 'one\nTWO\nthree\nfour\n');
    assert.deepEqual(kinds(), ['changed']);

    await vscode.commands.executeCommand('undo');

    assert.equal(editor.document.getText(), AFTER);
    await waitFor('the block to come back', () => kinds()?.length === 2);
    await sleep(500);
    assert.equal(storedBaseline(path), BEFORE, 'only Keep moves the baseline');
    assert.deepEqual(kinds(), ['changed', 'added']);
  });

  it('leaves unsaved work unsaved when it discards a block', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 2);
    assert.equal(editor.document.isDirty, true);

    const result = await vscode.commands.executeCommand('clause.discardBlock', blockTarget(api.model.files()[0]!, 1));

    assert.deepEqual(result, { ok: true });
    assert.equal(editor.document.getText(), 'one\nTWO\nmy three\nfour\n');
    assert.equal(editor.document.isDirty, true);
    assert.equal(read(path), AFTER, 'the disk still holds what Claude wrote');
    assert.equal(file.path, path);
  });

  it('leaves unsaved work unsaved when it discards the whole file, typing included, and Ctrl+Z brings the blocks back', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 2);
    assert.equal(editor.document.isDirty, true);

    assertOk(await vscode.commands.executeCommand('clause.discardFile', fileTarget(file)));

    assert.equal(editor.document.getText(), BEFORE, 'typing differs from the baseline like anything else, so it goes with the rest');
    assert.equal(editor.document.isDirty, true);
    assert.equal(read(path), AFTER, 'the disk still holds what Claude wrote');

    await vscode.commands.executeCommand('undo');

    assert.equal(editor.document.getText(), 'one\nTWO\nmy three\nfour\nfive\n');
    await waitFor('the blocks to come back', () => kinds()?.length === 2);
    await sleep(500);
    assert.equal(storedBaseline(path), BEFORE, 'only Keep moves the baseline');
  });

  it('reverts the typing that joined a block when the block is discarded, and Ctrl+Z brings it back', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 2);
    await waitFor('the typing to join the block above it', () => api.model.files()[0]?.state.blocks[0]?.curEnd === 3);

    assertOk(await vscode.commands.executeCommand('clause.discardBlock', blockTarget(api.model.files()[0]!, 0)));

    assert.equal(editor.document.getText(), 'one\ntwo\nthree\nfour\nfive\n');
    assert.equal(editor.document.isDirty, true, 'unsaved work stays unsaved');
    assert.equal(read(path), AFTER);
    assert.deepEqual(kinds(), ['added']);

    await vscode.commands.executeCommand('undo');

    assert.equal(editor.document.getText(), 'one\nTWO\nmy three\nfour\nfive\n');
    await waitFor('the block to come back', () => kinds()?.length === 2);
    assert.equal(storedBaseline(path), BEFORE);
  });

  it('does not write its baseline over an entry Claude started after the one it follows', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const entries = store();
    const id = entries.idFor(path);
    const firstEntry = entries.readMeta(id)!.createdAt;
    const NEWER = 'ZERO\nTWO\nthree\nfour\n';

    // No pause between replacing the entry and the keep: the window has not heard of the new entry yet.
    entries.removeEntry(id);
    assert.ok(entries.createEntry({ path, existed: true, base: Buffer.from(NEWER) }), 'a newer entry was created');
    assert.notEqual(entries.readMeta(id)!.createdAt, firstEntry, 'the newer entry is told apart by its timestamp');
    await api.model.keepBlock(file.id, file.state.blocks[0]!);

    await sleep(600);
    assert.equal(storedBaseline(path), NEWER);
  });

  it('makes typing that touches no block a block of its own, and leaves the stored baseline alone', async () => {
    const path = seedEdited('a.txt', WIDE_BEFORE, WIDE_AFTER);
    const entries = store();
    const id = entries.idFor(path);
    const metaBefore = entries.readMeta(id);
    await onlyPendingFile(api);
    const editor = await open(path);

    await typeAt(editor, 5);

    await waitFor('the typing to become a block', () => kinds()?.length === 2);
    await sleep(600);
    assert.deepEqual(kinds(), ['changed', 'changed']);
    assert.equal(storedBaseline(path), WIDE_BEFORE, 'nothing the user types enters the baseline');
    assert.deepEqual(entries.readMeta(id), metaBefore);
  });

  it('keeps two typing edits with an unchanged line between them as two blocks', async () => {
    const path = seedEdited('a.txt', WIDE_BEFORE, WIDE_AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);

    await typeAt(editor, 3);
    await typeAt(editor, 5);

    await waitFor('three blocks', () => kinds()?.length === 3);
    assert.deepEqual(
      api.model.files()[0]?.state.blocks.map((block) => [block.curStart, block.curEnd]),
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    );
  });

  it('makes typing inside a block part of that block', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);

    await editor.edit((edit) => edit.insert(new vscode.Position(1, 3), '!'));
    await sleep(600);

    assert.equal(storedBaseline(path), BEFORE);
    assert.deepEqual(kinds(), ['changed', 'added']);
  });

  it('keeps a block of typing: the baseline takes it in and the unsaved text stays as it is', async () => {
    const path = seedEdited('a.txt', WIDE_BEFORE, WIDE_AFTER);
    const file = await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 5);
    await waitFor('the typing to become a block', () => kinds()?.length === 2);

    assertOk(await api.model.keepBlock(file.id, api.model.files()[0]!.state.blocks[1]!));

    assert.equal(storedBaseline(path), 'one\ntwo\nthree\nfour\nfive\nmy six\nseven\n');
    assert.equal(editor.document.getText(), 'one\nTWO\nthree\nfour\nfive\nmy six\nseven\n');
    assert.equal(editor.document.isDirty, true);
    assert.deepEqual(kinds(), ['changed']);
  });

  it('drops the block of typing again when the unsaved typing is thrown away', async () => {
    const path = seedEdited('a.txt', WIDE_BEFORE, WIDE_AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 5);
    await waitFor('the typing to become a block', () => kinds()?.length === 2);

    await vscode.commands.executeCommand('workbench.action.files.revert');

    await waitFor('the block to go', () => kinds()?.length === 1);
    assert.equal(editor.document.getText(), WIDE_AFTER);
    assert.equal(storedBaseline(path), WIDE_BEFORE);
  });

  it('stops following a file once its last block is kept, so typing in it makes no block', async () => {
    const path = seedEdited('a.txt', 'one\ntwo\n', 'one\nTWO\n');
    const file = await onlyPendingFile(api);
    const editor = await open(path);

    assertOk(await api.model.keepBlock(file.id, file.state.blocks[0]!));
    await waitFor('the file to be finished', () => api.model.files().length === 0);
    assert.equal(hasEntry(path), false);

    await typeAt(editor, 0);
    await sleep(600);

    assert.equal(api.model.files().length, 0);
    assert.equal(hasEntry(path), false, 'typing does not start an entry');
  });

  it('keeps what Claude writes to an open file out of the baseline', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);

    writeFileSync(path, `${AFTER}six\n`);

    await waitFor('the editor to show the new text', () => editor.document.getText() === `${AFTER}six\n`);
    await waitFor('the added block to grow', () => api.model.files()[0]?.state.blocks[1]?.curEnd === 6);
    await sleep(600);
    assert.equal(storedBaseline(path), BEFORE);
  });

  it('shows a model started later the same blocks, the typing among them', async () => {
    const path = seedEdited('a.txt', WIDE_BEFORE, WIDE_AFTER);
    await onlyPendingFile(api);
    const editor = await open(path);
    await typeAt(editor, 5);
    await waitFor('the typing to become a block', () => kinds()?.length === 2);

    const later = new PendingModel(store(), () => {});
    later.start();
    try {
      await waitFor('the later window to load the file', () => later.files().length === 1);
      assert.equal(later.files()[0]?.state.blocks.length, 2);
      assert.deepEqual(later.files()[0]?.state.blocks, api.model.files()[0]?.state.blocks);
    } finally {
      later.dispose();
    }
  });

  it('follows a keep made in another window', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const other = new PendingModel(store(), () => {});
    other.start();
    try {
      await waitFor('the other window to load the file', () => other.files().length === 1);

      assertOk(await api.model.keepBlock(file.id, file.state.blocks[0]!));

      await waitFor('the other window to see the keep', () => other.files()[0]?.state.blocks.length === 1);
      assert.deepEqual(
        other.files()[0]?.state.blocks.map((block) => block.kind),
        ['added'],
      );
    } finally {
      other.dispose();
    }
  });

  it('shows the file as finished once another window decides on all of it', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const other = new PendingModel(store(), () => {});
    other.start();
    try {
      await waitFor('the other window to load the file', () => other.files().length === 1);
      assertOk(await other.discardFile(file.id));
      await waitFor('this window to see it', () => api.model.files().length === 0);
      assert.equal(read(path), BEFORE);
    } finally {
      other.dispose();
    }
  });
});
