import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { BASELINE_SCHEME } from '../../src/ui/diff.ts';
import { extensionApi, pendingAt, reset, seedCreated, seedEdited, seedEditedElsewhere, sleep, waitFor } from './helpers.ts';

const BEFORE = 'one\ntwo\nthree\n';
const AFTER = 'one\nTWO\nthree\n';

// The editor has TabInputTextMultiDiff; the typings this project builds against (1.100) do not list it.
const MultiDiffInput = (vscode as unknown as { TabInputTextMultiDiff: new (...args: never[]) => { readonly textDiffs: readonly vscode.TabInputTextDiff[] } }).TabInputTextMultiDiff;

type Resource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

describe('Review All Changes', () => {
  let api: ExtensionApi;
  const messages: string[] = [];
  const warnings: string[] = [];
  /** The arguments of each `vscode.changes` call, the editor's own command for a multi-file diff. */
  let changesCalls: { title: string; resources: Resource[] }[] = [];
  let failChanges: string | undefined;
  const realTell = vscode.window.showInformationMessage;
  const realWarn = vscode.window.showWarningMessage;
  const realExecute = vscode.commands.executeCommand;

  before(async () => {
    api = await extensionApi();
  });
  beforeEach(() => {
    messages.length = 0;
    warnings.length = 0;
    changesCalls = [];
    failChanges = undefined;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    };
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
    // Only watches: the call goes on to the editor unless the test makes it fail.
    (vscode.commands as { executeCommand: unknown }).executeCommand = (command: string, ...args: unknown[]) => {
      if (command === 'vscode.changes') {
        changesCalls.push({ title: args[0] as string, resources: args[1] as Resource[] });
        if (failChanges !== undefined) return Promise.reject(new Error(failChanges));
      }
      return realExecute(command, ...args);
    };
  });
  afterEach(async () => {
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = realTell;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = realWarn;
    (vscode.commands as { executeCommand: unknown }).executeCommand = realExecute;
    await reset(api);
  });

  const multiDiffTab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input instanceof MultiDiffInput);
  const shownDiffs = () => (multiDiffTab()?.input as { textDiffs: readonly vscode.TabInputTextDiff[] } | undefined)?.textDiffs ?? [];
  const tabCount = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;

  /** Runs Review All and waits for the multi-file diff to be in a tab. */
  async function reviewAll(): Promise<readonly vscode.TabInputTextDiff[]> {
    await vscode.commands.executeCommand('clause.reviewAll');
    await waitFor('the multi-file diff', () => multiDiffTab() !== undefined);
    return shownDiffs();
  }

  it('opens one multi-file diff of the pending files, in the order Claude changed them', async () => {
    // Not in the order of their names, which is how the panel lists them.
    const second = seedEdited('b.txt', BEFORE, AFTER);
    await sleep(5);
    const first = seedEdited('a.txt', BEFORE, AFTER);
    await waitFor('both files', () => pendingAt(api, first) !== undefined && pendingAt(api, second) !== undefined);

    const diffs = await reviewAll();

    assert.deepEqual(
      diffs.map((diff) => diff.modified.fsPath),
      [second, first],
    );
    // The editor adds the number of files to the title.
    assert.match(multiDiffTab()?.label ?? '', /^Pending changes \(before Claude ↔ now\)/);
    assert.equal(changesCalls.length, 1);
  });

  it('has the file as it was before Claude on the left and as it is now on the right', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await waitFor('the file', () => pendingAt(api, path) !== undefined);
    const file = pendingAt(api, path)!;

    const [diff] = await reviewAll();

    assert.equal(diff?.original.scheme, BASELINE_SCHEME);
    assert.equal(diff?.original.query, file.id);
    assert.equal(diff?.modified.toString(), file.uri.toString());
    assert.equal((await vscode.workspace.openTextDocument(diff!.original)).getText(), BEFORE);
    assert.equal(basename(diff!.original.path), 'a.txt', 'the path is the file\'s own, so that the editor picks its language');
  });

  it('gives a file Claude created an empty left side', async () => {
    const path = seedCreated('new.txt', 'a\nb\n');
    await waitFor('the file', () => pendingAt(api, path) !== undefined);

    const [diff] = await reviewAll();

    assert.equal(diff?.original.scheme, BASELINE_SCHEME);
    assert.equal(diff?.original.query, '');
    assert.equal((await vscode.workspace.openTextDocument(diff!.original)).getText(), '');
    assert.equal(diff?.modified.fsPath, path);
  });

  it('gives a file Claude deleted its baseline on the left and no right side', async () => {
    const path = seedEdited('gone.txt', BEFORE, AFTER);
    await waitFor('the file', () => pendingAt(api, path) !== undefined);
    rmSync(path);
    await waitFor('the file to show as deleted', () => pendingAt(api, path)?.state.situation === 'deleted');

    await vscode.commands.executeCommand('clause.reviewAll');

    assert.equal(changesCalls.length, 1);
    const [[label, original, modified]] = changesCalls[0]!.resources as [Resource];
    assert.equal(label.fsPath, path);
    assert.equal(original?.scheme, BASELINE_SCHEME);
    assert.equal(original?.query, pendingAt(api, path)!.id);
    assert.equal(modified, undefined);
  });

  it('leaves out a file of another project and a file that cannot be compared line by line', async () => {
    const inside = seedEdited('a.txt', BEFORE, AFTER);
    seedEdited('data.bin', Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x02]));
    const other = seedEditedElsewhere('other.txt', BEFORE, AFTER, null);
    await waitFor('all three files', () => api.model.files().length === 3 && pendingAt(api, other) !== undefined);

    const diffs = await reviewAll();

    assert.deepEqual(
      diffs.map((diff) => diff.modified.fsPath),
      [inside],
    );
  });

  it('includes a file outside the folder that a session started in the folder changed', async () => {
    const inside = seedEdited('a.txt', BEFORE, AFTER);
    await sleep(5);
    const outside = seedEditedElsewhere('outside.txt', BEFORE, AFTER);
    await waitFor('both files', () => pendingAt(api, inside) !== undefined && pendingAt(api, outside) !== undefined);

    const diffs = await reviewAll();

    assert.deepEqual(
      diffs.map((diff) => diff.modified.fsPath),
      [inside, outside],
    );
  });

  it('says so, and opens nothing, when nothing is pending', async () => {
    await vscode.commands.executeCommand('clause.reviewAll');

    assert.deepEqual(messages, ['Nothing is pending.']);
    assert.equal(tabCount(), 0);
    assert.equal(changesCalls.length, 0);
  });

  it('says so, and opens nothing, when no pending file can be compared line by line', async () => {
    seedEdited('data.bin', Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x02]));
    await waitFor('the file', () => api.model.files().length === 1);

    await vscode.commands.executeCommand('clause.reviewAll');

    assert.deepEqual(messages, ['None of the pending files is text that can be compared line by line.']);
    assert.equal(tabCount(), 0);
    assert.equal(changesCalls.length, 0);
  });

  it('reports a failure of the editor\'s command to the user, and does not throw', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    await waitFor('the file', () => api.model.files().length === 1);
    failChanges = 'there is no such command';

    await vscode.commands.executeCommand('clause.reviewAll');

    assert.deepEqual(warnings, ['Could not open the combined diff: there is no such command']);
    assert.equal(tabCount(), 0);
  });
});
