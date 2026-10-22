import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, extensionApi, hasEntry, onlyPendingFile, pendingAt, reset, seedEdited, seedEditedElsewhere, sleep, store, waitFor, workspaceDir } from './helpers.ts';

// Claude changed line 2 and added a line at the end: two blocks.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';
// Claude changed line 2 only: one block.
const SMALL_AFTER = 'one\nTWO\nthree\nfour\n';

// The model batches the store's events for 50 ms; this is long enough to be sure it has had its say.
const QUIET_MS = 300;

const PROJECT = '/work/project';
const OTHER = '/work/other';

describe('which sessions changed a pending file', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('gives the file the folders its entry records', async () => {
    seedEdited('a.txt', BEFORE, AFTER, PROJECT);

    const file = await onlyPendingFile(api);

    assert.deepEqual(file.sessionDirs, [PROJECT]);
  });

  it('gives a file from before sessions were recorded none', async () => {
    seedEdited('a.txt', BEFORE, AFTER);

    const file = await onlyPendingFile(api);

    assert.deepEqual(file.sessionDirs, []);
  });

  it('picks up a folder written after the file was loaded, and says so', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER, PROJECT);
    await onlyPendingFile(api);
    await sleep(QUIET_MS);
    let changes = 0;
    const subscription = api.model.onDidChange(() => changes++);

    try {
      assert.ok(store().addSessionDir(store().idFor(path), OTHER));
      await waitFor('the change', () => changes > 0);
    } finally {
      subscription.dispose();
    }

    assert.deepEqual(pendingAt(api, path)?.sessionDirs, [PROJECT, OTHER]);
  });
});

describe('counting a part of what is pending', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('counts the files it is given, and everything when it is given none', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    const small = seedEdited('b.txt', BEFORE, SMALL_AFTER);
    await waitFor('both files', () => api.model.files().length === 2);
    const smallFile = pendingAt(api, small)!;

    assert.deepEqual(api.model.counts(), { pending: 3, files: 2 });
    assert.deepEqual(api.model.counts([smallFile]), { pending: 1, files: 1 });
    assert.deepEqual(api.model.counts([]), { pending: 0, files: 0 });
  });
});

describe('what the panel lists', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const folder = workspaceDir();
  const labels = () => api.tree.getChildren().map((node) => (node.kind === 'group' ? 'group' : basename(api.model.fileById(node.id)!.path)));
  const groupFiles = () => {
    const group = api.tree.getChildren().find((node) => node.kind === 'group');
    return group === undefined ? [] : api.tree.getChildren(group).map((node) => (node.kind === 'file' ? basename(api.model.fileById(node.id)!.path) : '?'));
  };
  const hasPendingKey = () => api.context.value('clause.hasPending');

  it('does not list a file outside the folder that no session started in it is known to have changed', async () => {
    seedEditedElsewhere('o.txt', 'o\n', 'O\n', null);
    await waitFor('the model to hold the file', () => api.model.files().length === 1);
    await sleep(QUIET_MS);

    assert.deepEqual(api.tree.getChildren(), []);
    assert.equal(api.summary.text, undefined);
    assert.equal(api.summary.badge, undefined);
    assert.equal(hasPendingKey(), false);
    assert.deepEqual(api.model.counts(), { pending: 1, files: 1 }, 'it stays pending');
  });

  it('lists a file outside the folder when a session started in the folder or inside it changed it', async () => {
    const started: Array<[string, string]> = [
      ['the folder', folder],
      ['a folder inside it', join(folder, 'sub', 'deeper')],
    ];
    for (const [name, sessionDir] of started) {
      seedEditedElsewhere('o.txt', 'o\n', 'O\n', sessionDir);
      await waitFor(`the group for a session in ${name}`, () => groupFiles().length === 1);

      assert.deepEqual(groupFiles(), ['o.txt'], name);
      assert.equal(api.summary.text, '$(diff) Clause: 1 pending · 1 file', name);
      assert.equal(api.summary.badge, 1, name);
      assert.equal(hasPendingKey(), true, name);
      await reset(api);
    }
  });

  it('does not list a file outside the folder when the session was started above it, beside it, or in a folder named like it', async () => {
    const parent = dirname(folder);
    const started: Array<[string, string]> = [
      ['above it', parent],
      ['beside it', join(parent, 'sibling')],
      ['named like it', `${folder}-other`],
      ['at the root', '/'],
    ];
    for (const [name, sessionDir] of started) {
      seedEditedElsewhere('o.txt', 'o\n', 'O\n', sessionDir);
      await waitFor('the model to hold the file', () => api.model.files().length === 1);
      await sleep(QUIET_MS);

      assert.deepEqual(api.tree.getChildren(), [], name);
      assert.equal(api.summary.text, undefined, name);
      assert.equal(hasPendingKey(), false, name);
      await reset(api);
    }
  });

  it('lists a file inside the folder with no session recorded, and when the session was started above', async () => {
    seedEdited('a.txt', 'a\n', 'A\n');
    seedEdited('b.txt', 'b\n', 'B\n', dirname(folder));
    await waitFor('both files to be listed', () => labels().length === 2);

    assert.deepEqual(labels(), ['a.txt', 'b.txt']);
    assert.equal(hasPendingKey(), true);
  });

  it('lists a file once a session folder is recorded for it, without anything else changing', async () => {
    const path = seedEditedElsewhere('o.txt', 'o\n', 'O\n', dirname(folder));
    await waitFor('the model to hold the file', () => api.model.files().length === 1);
    await sleep(QUIET_MS);
    assert.deepEqual(api.tree.getChildren(), []);

    assert.ok(store().addSessionDir(store().idFor(path), folder));

    await waitFor('the group to appear', () => groupFiles().length === 1);
    await waitFor('the status bar item to appear', () => api.summary.text === '$(diff) Clause: 1 pending · 1 file');
    await waitFor('the panel to be shown', () => hasPendingKey() === true);
  });

  it('counts what it lists and nothing else', async () => {
    seedEdited('a.txt', 'one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nfour\nfive\n');
    seedEditedElsewhere('listed.txt', 'o\n', 'O\n');
    seedEditedElsewhere('hidden.txt', 'h\n', 'H\n', null);
    await waitFor('all three files to be pending', () => api.model.files().length === 3);

    await waitFor('the counts', () => api.summary.text === '$(diff) Clause: 3 pending · 2 files');

    assert.equal(api.summary.badge, 2, 'two files listed, with three changes between them');
    assert.deepEqual(labels(), ['a.txt', 'group']);
    assert.deepEqual(groupFiles(), ['listed.txt']);
    assert.deepEqual(api.model.counts(), { pending: 4, files: 3 }, 'the model still holds the hidden file');
  });

  describe('Keep All and Discard All', () => {
    async function seedScene() {
      const files = {
        inside: seedEdited('a.txt', 'a\n', 'A\n'),
        listed: seedEditedElsewhere('listed.txt', 'l\n', 'L\n'),
        hidden: seedEditedElsewhere('hidden.txt', 'h\n', 'H\n', null),
      };
      await waitFor('all three files to be pending', () => api.model.files().length === 3);
      return files;
    }

    it('keep only what is inside the folder, and the group\'s own button keeps only the group', async () => {
      const { inside, listed, hidden } = await seedScene();

      assertOk(await vscode.commands.executeCommand('clause.keepAll'));
      assert.deepEqual([hasEntry(inside), hasEntry(listed), hasEntry(hidden)], [false, true, true]);

      assertOk(await vscode.commands.executeCommand('clause.keepAll', { kind: 'group' }));
      assert.deepEqual([hasEntry(inside), hasEntry(listed), hasEntry(hidden)], [false, false, true]);
    });

    it('discard only what is inside the folder, and the group\'s own button discards only the group', async () => {
      const { inside, listed, hidden } = await seedScene();

      assertOk(await vscode.commands.executeCommand('clause.discardAll'));
      assert.deepEqual([hasEntry(inside), hasEntry(listed), hasEntry(hidden)], [false, true, true]);

      assertOk(await vscode.commands.executeCommand('clause.discardAll', { kind: 'group' }));
      assert.deepEqual([hasEntry(inside), hasEntry(listed), hasEntry(hidden)], [false, false, true]);
    });
  });
});
