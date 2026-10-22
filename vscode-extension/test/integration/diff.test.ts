import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import type { PendingFile } from '../../src/pending.ts';
import { BASELINE_SCHEME } from '../../src/ui/diff.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, onlyPendingFile, pendingAt, reset, seedCreated, seedEdited, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// "café\n" in Latin-1 and the same with a second é: bytes that are not UTF-8, so there are no lines to compare.
const LATIN1_BEFORE = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
const LATIN1_AFTER = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]);

describe('Open diff', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  const diffTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputTextDiff);

  /** The diff editor the command just opened. */
  async function shownDiff(): Promise<vscode.TabInputTextDiff> {
    await waitFor('the diff editor', () => activeTab()?.input instanceof vscode.TabInputTextDiff);
    return activeTab()!.input as vscode.TabInputTextDiff;
  }

  async function seedDeleted(): Promise<PendingFile> {
    const path = seedEdited('gone.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    rmSync(path);
    await waitFor('the file to show as deleted', () => pendingAt(api, path)?.state.situation === 'deleted');
    return pendingAt(api, path)!;
  }

  describe('on a file Claude changed', () => {
    it('opens the file as it was before Claude beside the file as it is now, in a tab that stays', async () => {
      seedEdited('a.txt', BEFORE, AFTER);
      const file = await onlyPendingFile(api);

      assertOk(await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file)));

      const diff = await shownDiff();
      assert.equal(diff.original.scheme, BASELINE_SCHEME);
      assert.equal(diff.original.query, file.id);
      assert.equal(diff.modified.toString(), file.uri.toString());
      assert.equal(activeTab()?.isPreview, false);
      assert.equal(activeTab()?.label, 'a.txt (before Claude ↔ now)');
    });

    it('reads the left side as the baseline', async () => {
      seedEdited('a.txt', BEFORE, AFTER);
      const file = await onlyPendingFile(api);
      await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file));

      const before = await vscode.workspace.openTextDocument((await shownDiff()).original);

      assert.equal(before.getText(), BEFORE);
    });

    it('moves the left side along when a block is kept', async () => {
      seedEdited('a.txt', BEFORE, AFTER);
      const file = await onlyPendingFile(api);
      await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file));
      const before = await vscode.workspace.openTextDocument((await shownDiff()).original);

      assertOk(await vscode.commands.executeCommand('claudePending.keepBlock', blockTarget(file, 0)));

      await waitFor('the left side to take in the kept block', () => before.getText() === 'one\nTWO\nthree\nfour\n');
    });
  });

  describe('on a file Claude created', () => {
    it('has nothing on the left', async () => {
      seedCreated('new.txt', 'hello\n');
      const file = await onlyPendingFile(api);

      await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file));

      const diff = await shownDiff();
      assert.equal(diff.original.scheme, BASELINE_SCHEME);
      assert.equal(diff.original.query, '');
      assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), '');
      assert.equal(diff.modified.toString(), file.uri.toString());
    });
  });

  describe('on a file that was deleted', () => {
    it('has the file as it was before Claude on the left and nothing on the right', async () => {
      const file = await seedDeleted();

      await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file));

      const diff = await shownDiff();
      assert.equal(diff.original.query, file.id);
      assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), BEFORE);
      assert.equal(diff.modified.scheme, BASELINE_SCHEME);
      assert.equal(diff.modified.query, '');
      assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), '');
    });

    it('is what revealing the file shows, since there is no file to open', async () => {
      const file = await seedDeleted();

      await vscode.commands.executeCommand('claudePending.reveal', fileTarget(file));

      assert.equal((await shownDiff()).original.query, file.id);
    });
  });

  describe('on a file that is not text', () => {
    it('opens nothing, because there are no lines to compare', async () => {
      seedEdited('latin1.txt', LATIN1_BEFORE, LATIN1_AFTER);
      const file = await onlyPendingFile(api);

      await vscode.commands.executeCommand('claudePending.openDiff', fileTarget(file));

      assert.deepEqual(diffTabs(), []);
    });
  });
});
