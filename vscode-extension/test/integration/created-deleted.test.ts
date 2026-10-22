import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, hasEntry, onlyPendingFile, open, pendingAt, read, reset, seedCreated, seedEdited, trashedFilesFolder, trashWorks, waitFor } from './helpers.ts';

type Outcome = { ok: boolean; reason?: string };

describe('a file Claude created', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('is one block, the whole file', async () => {
    seedCreated('new.txt', 'hello\nworld\n');

    const file = await onlyPendingFile(api);

    assert.equal(file.state.situation, 'created');
    // Three lines: a text that ends in a newline ends in an empty line, the way editors number them.
    assert.deepEqual(file.state.blocks, [{ kind: 'added', baseStart: 0, baseEnd: 0, curStart: 0, curEnd: 3 }]);
    assert.deepEqual(api.model.counts(), { pending: 1, files: 1 });
  });

  it('stays on disk when kept, and is no longer pending', async () => {
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('claudePending.keepFile', fileTarget(file)));

    assert.equal(read(path), 'hello\n');
    assert.equal(hasEntry(path), false);
    assert.equal(api.model.files().length, 0);
  });

  it('is kept whole by Keep on its only block', async () => {
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('claudePending.keepBlock', blockTarget(file, 0)));

    assert.equal(read(path), 'hello\n');
    assert.equal(hasEntry(path), false);
  });

  it('is moved to the trash when discarded, not deleted for good', async function () {
    if (!(await trashWorks())) return this.skip();
    // Text of its own, so that this file can be told apart from the others the tests have trashed.
    const text = 'only this test trashes this text\n';
    const path = seedCreated('new.txt', text);
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('claudePending.discardFile', fileTarget(file)));

    assert.equal(existsSync(path), false);
    assert.equal(hasEntry(path), false);
    assert.equal(api.model.files().length, 0);
    const trash = trashedFilesFolder();
    if (trash !== undefined) {
      assert.ok(
        readdirSync(trash).some((name) => readFileSync(join(trash, name), 'utf8') === text),
        'the file is in the trash',
      );
    }
  });

  it('is moved to the trash by Discard on its only block, too', async function () {
    if (!(await trashWorks())) return this.skip();
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('claudePending.discardBlock', blockTarget(file, 0)));

    assert.equal(existsSync(path), false);
    assert.equal(hasEntry(path), false);
  });

  it('is closed in the editor before it goes to the trash', async function () {
    if (!(await trashWorks())) return this.skip();
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);
    await open(path);
    const isOpen = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === path);
    assert.equal(isOpen(), true, 'the file is open before it is discarded');

    assertOk(await vscode.commands.executeCommand('claudePending.discardFile', fileTarget(file)));

    assert.equal(isOpen(), false);
  });

  it('stays pending, with the reason, where files cannot be moved to a trash', async function () {
    if (await trashWorks()) return this.skip();
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    const result = await vscode.commands.executeCommand<Outcome>('claudePending.discardFile', fileTarget(file));

    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /^Could not move new\.txt to the trash: /);
    assert.equal(read(path), 'hello\n');
    assert.equal(hasEntry(path), true);
    assert.equal(api.model.files().length, 1);
  });

  it('is forgotten once the user has deleted it themselves', async () => {
    const path = seedCreated('new.txt', 'hello\n');
    await onlyPendingFile(api);

    rmSync(path);

    await waitFor('the file to leave the review', () => api.model.files().length === 0);
    // The entry is only removed after a pause and a second look at the disk, so that a write that is still arriving is not lost.
    await waitFor('the entry to be forgotten', () => !hasEntry(path), 15_000);
  });
});

describe('a file deleted after Claude changed it', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** Seeds an edited file, deletes it as the user would, and waits until the review shows it as deleted. */
  async function seedThenDelete(before: string, after: string): Promise<string> {
    const path = seedEdited('gone.txt', before, after);
    await onlyPendingFile(api);
    rmSync(path);
    await waitFor('the file to show as deleted', () => pendingAt(api, path)?.state.situation === 'deleted');
    return path;
  }

  it('is one block, all the lines it had', async () => {
    const path = await seedThenDelete('a\nb\n', 'a\nB\n');

    // 'a\nb\n' is three lines for the same reason as in the created-file test above.
    assert.deepEqual(pendingAt(api, path)!.state.blocks, [{ kind: 'removed', baseStart: 0, baseEnd: 3, curStart: 0, curEnd: 0 }]);
    assert.deepEqual(api.model.counts(), { pending: 1, files: 1 });
  });

  it('is written back from the baseline when discarded', async () => {
    const path = await seedThenDelete('a\nb\n', 'a\nB\n');

    assertOk(await vscode.commands.executeCommand('claudePending.discardFile', fileTarget(pendingAt(api, path)!)));

    assert.equal(read(path), 'a\nb\n');
    assert.equal(hasEntry(path), false);
  });

  it('is written back by Discard on its only block, too', async () => {
    const path = await seedThenDelete('a\nb\n', 'a\nB\n');

    assertOk(await vscode.commands.executeCommand('claudePending.discardBlock', blockTarget(pendingAt(api, path)!, 0)));

    assert.equal(read(path), 'a\nb\n');
  });

  it('is written back together with the folder it was in', async () => {
    const path = await seedThenDelete('a\nb\n', 'a\nB\n');
    rmSync(dirname(path), { recursive: true });
    await api.model.refreshAll();

    assertOk(await vscode.commands.executeCommand('claudePending.discardFile', fileTarget(pendingAt(api, path)!)));

    assert.equal(read(path), 'a\nb\n');
  });

  it('stays deleted when kept, and is no longer pending', async () => {
    const path = await seedThenDelete('a\nb\n', 'a\nB\n');

    assertOk(await vscode.commands.executeCommand('claudePending.keepFile', fileTarget(pendingAt(api, path)!)));

    assert.equal(existsSync(path), false);
    assert.equal(hasEntry(path), false);
    assert.equal(api.model.files().length, 0);
  });
});
