import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, extensionApi, fileTarget, onlyPendingFile, open, pendingAt, reset, seedCreated, seedEdited, seedEditedElsewhere, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

const EXPANDED = vscode.TreeItemCollapsibleState.Expanded;
const NOT_COLLAPSIBLE = vscode.TreeItemCollapsibleState.None;

describe('the Clause view', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const itemOf = (node: Parameters<ExtensionApi['tree']['getTreeItem']>[0]) => api.tree.getTreeItem(node);

  it('is empty when nothing is pending', () => {
    assert.deepEqual(api.tree.getChildren(), []);
  });

  it('lists a file Claude changed, with the folder it is in', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    const roots = api.tree.getChildren();

    assert.deepEqual(roots, [fileTarget(file)]);
    const item = itemOf(roots[0]!);
    assert.equal(item.label, 'a.txt');
    assert.equal(item.id, `file:${file.id}`);
    // One line changed (+1 −1) and one added (+1).
    assert.equal(item.description, `${basename(dirname(path))} · +2 −1`);
    assert.equal(item.contextValue, 'file');
    assert.equal(item.collapsibleState, EXPANDED);
    assert.deepEqual(item.command?.arguments, [roots[0]]);
  });

  it('lists the blocks of a file under it, in order, with the line each starts on', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    const blocks = api.tree.getChildren(fileTarget(file));

    assert.deepEqual(
      blocks.map((block) => itemOf(block).label),
      ['Changed 1 line', 'Added 1 line'],
    );
    assert.deepEqual(
      blocks.map((block) => itemOf(block).description),
      ['line 2', 'line 5'],
    );
    assert.deepEqual(
      blocks.map((block) => itemOf(block).contextValue),
      ['block', 'block'],
    );
    assert.deepEqual(api.tree.getChildren(blocks[0]!), [], 'a block has nothing under it');
  });

  it('marks a file Claude created as new, with no blocks to list', async () => {
    const path = seedCreated('new.txt', 'hello\n');
    const file = await onlyPendingFile(api);

    const item = itemOf(fileTarget(file));

    assert.equal(item.description, `${basename(dirname(path))} · new · +1`);
    assert.equal(item.collapsibleState, NOT_COLLAPSIBLE);
    assert.deepEqual(api.tree.getChildren(fileTarget(file)), []);
  });

  it('marks a file that was deleted after Claude changed it', async () => {
    const path = seedEdited('gone.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    rmSync(path);
    await waitFor('the file to show as deleted', () => pendingAt(api, path)?.state.situation === 'deleted');

    const item = itemOf(fileTarget(pendingAt(api, path)!));

    assert.equal(item.description, `${basename(dirname(path))} · deleted · −4`);
    assert.equal(item.collapsibleState, NOT_COLLAPSIBLE);
  });

  it('shows no line counts for a file that can only be kept or discarded whole', async () => {
    const path = seedEdited('a.bin', Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]));
    const file = await onlyPendingFile(api);

    assert.equal(itemOf(fileTarget(file)).description, basename(dirname(path)));
  });

  it('puts files outside this folder that this folder\'s sessions changed under "Outside this folder", after the ones in it', async () => {
    seedEdited('a.txt', 'a\n', 'A\n');
    seedEditedElsewhere('o.txt', 'o\n', 'O\n');
    await waitFor('both files to be pending', () => api.model.files().length === 2);

    const roots = api.tree.getChildren();

    assert.deepEqual(
      roots.map((node) => node.kind),
      ['file', 'group'],
    );
    const group = itemOf(roots[1]!);
    assert.equal(group.label, 'Outside this folder');
    assert.equal(group.id, 'group:outside');
    assert.equal(group.tooltip, 'Files outside this folder that Claude sessions started in this folder changed');
    assert.equal(group.description, '1 file');
    assert.equal(group.contextValue, 'group');
    assert.equal(group.collapsibleState, EXPANDED);
    assert.deepEqual(
      api.tree.getChildren(roots[1]!).map((node) => itemOf(node).label),
      ['o.txt'],
    );
  });

  it('says that a file has been decided when it is no longer pending', () => {
    const item = itemOf({ kind: 'file', id: '0'.repeat(64) });

    assert.equal(item.label, '(already decided)');
  });

  it('is told to refresh when a file is kept', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    let refreshes = 0;
    const subscription = api.tree.onDidChangeTreeData(() => refreshes++);

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(file)));

    await waitFor('the view to be told', () => refreshes > 0);
    subscription.dispose();
  });
});

describe('the status bar', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('counts what is waiting, in changes and in files, and goes away when nothing is', async () => {
    assert.equal(api.summary.text, undefined);
    const first = seedEdited('a.txt', BEFORE, AFTER);
    const second = seedEdited('b.txt', 'x\ny\n', 'x\nY\n');

    await waitFor('both files to be counted', () => api.summary.text === '$(diff) Clause: 3 pending · 2 files');

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(pendingAt(api, second)!)));
    await waitFor('one file to be left', () => api.summary.text === '$(diff) Clause: 2 pending · 1 file');

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(pendingAt(api, first)!)));
    await waitFor('the count to go away', () => api.summary.text === undefined);
  });
});

describe('the badge and the heading of the view', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('counts files on the badge, and says the files and the changes in its tooltip and in the heading', async () => {
    assert.equal(api.summary.badge, undefined);
    assert.equal(api.summary.badgeTooltip, undefined);
    assert.equal(api.summary.viewDescription, undefined);
    // Two changes in the first file, one in the second.
    const first = seedEdited('a.txt', BEFORE, AFTER);
    const second = seedEdited('b.txt', 'x\ny\n', 'x\nY\n');

    await waitFor('both files to be counted', () => api.summary.badge === 2);
    assert.equal(api.summary.badgeTooltip, '2 files · 3 changes to review');
    assert.equal(api.summary.viewDescription, '2 files · 3 changes');

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(pendingAt(api, second)!)));
    await waitFor('one file to be left', () => api.summary.badge === 1);
    assert.equal(api.summary.badgeTooltip, '1 file · 2 changes to review');
    assert.equal(api.summary.viewDescription, '1 file · 2 changes');

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(pendingAt(api, first)!)));
    await waitFor('the badge to go away', () => api.summary.badge === undefined);
    assert.equal(api.summary.viewDescription, undefined);
  });
});

describe('the tints in an editor', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  async function openPending(path: string): Promise<vscode.TextEditor> {
    await onlyPendingFile(api);
    return open(path);
  }

  it('tints the lines Claude changed or added, and records what a changed line was', async () => {
    const editor = await openPending(seedEdited('a.txt', BEFORE, AFTER));

    await waitFor('the tints', () => api.decorations.appliedTo(editor)?.added.length === 2);

    assert.deepEqual(
      api.decorations.appliedTo(editor)!.added.map(({ startLine, endLine, replaced }) => [startLine, endLine, replaced.lines]),
      [
        [1, 1, ['two']],
        [4, 4, []],
      ],
    );
  });

  it('marks the line after which lines were removed', async () => {
    const editor = await openPending(seedEdited('a.txt', 'one\ntwo\nthree\n', 'one\nthree\n'));

    await waitFor('the marker', () => api.decorations.appliedTo(editor)?.removed.length === 1);

    const [gap] = api.decorations.appliedTo(editor)!.removed;
    assert.deepEqual([gap!.line, gap!.edge, gap!.count, gap!.removed.lines], [0, 'below', 1, ['two']]);
  });

  it('puts the marker above the first line when the lines removed were the first', async () => {
    const editor = await openPending(seedEdited('a.txt', 'one\ntwo\n', 'two\n'));

    await waitFor('the marker', () => api.decorations.appliedTo(editor)?.removed.length === 1);

    const [gap] = api.decorations.appliedTo(editor)!.removed;
    assert.deepEqual([gap!.line, gap!.edge, gap!.count], [0, 'above', 1]);
  });

  it('tints a file Claude created from its first line', async () => {
    const editor = await openPending(seedCreated('new.txt', 'hello\nworld\n'));

    await waitFor('the tints', () => api.decorations.appliedTo(editor)?.added.length === 1);

    const plan = api.decorations.appliedTo(editor)!;
    assert.equal(plan.added[0]!.startLine, 0);
    assert.deepEqual(plan.removed, []);
  });

  it('draws nothing once the file has been kept', async () => {
    const editor = await openPending(seedEdited('a.txt', BEFORE, AFTER));
    await waitFor('the tints', () => api.decorations.appliedTo(editor)?.added.length === 2);

    assertOk(await vscode.commands.executeCommand('clause.keepFile', fileTarget(await onlyPendingFile(api))));

    await waitFor('the tints to go', () => api.decorations.appliedTo(editor)?.added.length === 0);
  });
});
