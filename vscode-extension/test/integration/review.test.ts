import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, extensionApi, hasEntry, read, reset, seedEdited, storedBaseline, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

describe('reviewing a file Claude changed', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** Waits for the one pending file and returns it. */
  async function pendingFile() {
    await waitFor('the file to be pending', () => api.model.files().length === 1);
    return api.model.files()[0]!;
  }

  it('lists the blocks of a file found in the store', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();
    assert.equal(file.path, path);
    assert.deepEqual(
      file.state.blocks.map((block) => block.kind),
      ['changed', 'added'],
    );
    assert.deepEqual(api.model.counts(), { pending: 2, files: 1 });
  });

  it('puts Keep, Discard and Diff above each block', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await pendingFile();
    // The command only answers for a document the workbench has open.
    await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.file(path));
    const lensesFor = (command: string) => lenses.filter((lens) => lens.command?.command === command);
    assert.deepEqual(
      lensesFor('clause.keepBlock').map((lens) => lens.range.start.line),
      [1, 4],
    );
    assert.equal(lensesFor('clause.discardBlock').length, 2);
    assert.equal(lensesFor('clause.openDiff').length, 2);
  });

  it('keeping a block makes it part of the baseline and leaves the file as it is', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();

    const result = await vscode.commands.executeCommand('clause.keepBlock', { kind: 'block', id: file.id, block: file.state.blocks[0] });

    assert.deepEqual(result, { ok: true });
    assert.equal(storedBaseline(path), 'one\nTWO\nthree\nfour\n');
    assert.equal(read(path), AFTER);
    assert.deepEqual(
      api.model.files()[0]?.state.blocks.map((block) => block.kind),
      ['added'],
    );
  });

  it('discarding a block puts the baseline lines back in the file', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();

    const result = await vscode.commands.executeCommand('clause.discardBlock', { kind: 'block', id: file.id, block: file.state.blocks[1] });

    assert.deepEqual(result, { ok: true });
    assert.equal(read(path), 'one\nTWO\nthree\nfour\n');
    assert.equal(storedBaseline(path), BEFORE);
    assert.deepEqual(
      api.model.files()[0]?.state.blocks.map((block) => block.kind),
      ['changed'],
    );
  });

  it('keeping the last block ends the review of the file at once', async () => {
    const path = seedEdited('a.txt', 'a\nb\n', 'a\nB\n');
    const file = await pendingFile();

    assertOk(await vscode.commands.executeCommand('clause.keepBlock', { kind: 'block', id: file.id, block: file.state.blocks[0] }));

    assert.equal(hasEntry(path), false);
    assert.equal(read(path), 'a\nB\n');
    assert.equal(api.model.files().length, 0);
  });

  it('discarding the last block ends the review of the file once the file is back as it was', async () => {
    const path = seedEdited('a.txt', 'a\nb\n', 'a\nB\n');
    const file = await pendingFile();

    assertOk(await vscode.commands.executeCommand('clause.discardBlock', { kind: 'block', id: file.id, block: file.state.blocks[0] }));

    assert.equal(read(path), 'a\nb\n');
    assert.equal(hasEntry(path), false);
    assert.equal(api.model.files().length, 0);
  });

  it('keeping a file takes it out of the review and leaves it as it is', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();

    const result = await vscode.commands.executeCommand('clause.keepFile', { kind: 'file', id: file.id });

    assert.deepEqual(result, { ok: true });
    assert.equal(read(path), AFTER);
    assert.equal(hasEntry(path), false);
  });

  it('discarding a file puts back every byte of the baseline', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();

    const result = await vscode.commands.executeCommand('clause.discardFile', { kind: 'file', id: file.id });

    assert.deepEqual(result, { ok: true });
    assert.equal(read(path), BEFORE);
    assert.equal(hasEntry(path), false);
  });

  it('refuses a block that is no longer where it was shown, and changes nothing', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await pendingFile();
    const stale = { ...file.state.blocks[0]!, curStart: 3, curEnd: 4 };

    const result = await vscode.commands.executeCommand<{ ok: boolean }>('clause.discardBlock', { kind: 'block', id: file.id, block: stale });

    assert.equal(result.ok, false);
    assert.equal(read(path), AFTER);
    assert.equal(storedBaseline(path), BEFORE);
  });

  it('keeps and discards in files of another folder tree too', async () => {
    const path = seedEdited('sub/dir/b.txt', 'x\n', 'y\n');
    const file = await pendingFile();
    assertOk(await vscode.commands.executeCommand('clause.discardFile', { kind: 'file', id: file.id }));
    assert.equal(read(path), 'x\n');
    assert.match(path, /sub[\\/]dir[\\/]b\.txt$/);
  });
});
