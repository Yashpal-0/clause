import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { extensionApi, pendingAt, store, waitFor, workspaceDir } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';
const FEATURE_BEFORE = 'one\nfeature\nthree\n';
const FEATURE_AFTER = 'one\nFEATURE\nthree\nfour\n';

describe('pending changes when the repository switches branch', () => {
  let api: ExtensionApi;
  const path = () => join(workspaceDir(), 'branch.txt');

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: workspaceDir(), encoding: 'utf8' });
  const onBranch = (branch: string) => git('checkout', '-q', branch);

  /** An entry for `path` as the hook would make it: the file holds `after`, the old bytes are kept. */
  const seed = (before: string, after: string) => {
    writeFileSync(path(), after);
    assert.ok(store().createEntry({ path: path(), existed: true, base: Buffer.from(before) }));
  };

  before(async () => {
    api = await extensionApi();
    git('init', '-q', '-b', 'master');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('branch', 'feature');
  });
  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const branch of ['feature', 'master']) {
      onBranch(branch);
      for (const { id } of store().listEntries()) store().removeEntry(id);
    }
    await api.model.refreshAll();
    await waitFor('the model to forget everything', () => api.model.files().length === 0);
  });
  after(() => {
    rmSync(join(workspaceDir(), '.git'), { recursive: true, force: true });
    rmSync(path(), { force: true });
  });

  it("lists only the current branch's change, and brings the other back on return", async () => {
    seed(BEFORE, AFTER);
    await waitFor('the master change to be listed', () => pendingAt(api, path()) !== undefined);
    const onMaster = store().idFor(path());

    onBranch('feature');
    await waitFor('the master change to leave the list', () => pendingAt(api, path()) === undefined);
    assert.equal(store().readEntry(onMaster)?.base?.toString(), BEFORE, 'and to stay in the store');
    seed(FEATURE_BEFORE, FEATURE_AFTER);
    await waitFor('the feature change to be listed', () => pendingAt(api, path()) !== undefined);
    assert.notEqual(store().idFor(path()), onMaster);

    onBranch('master');
    writeFileSync(path(), AFTER);
    await waitFor('the master change to come back', () => pendingAt(api, path()) !== undefined);
    await waitFor('with the blocks the file now has', () => pendingAt(api, path())?.state.blocks.length === 2);
  });

  it('refuses a Keep that arrives after the branch moved', async () => {
    seed(BEFORE, AFTER);
    await waitFor('the change to be listed', () => pendingAt(api, path()) !== undefined);
    const file = api.model.files()[0]!;

    onBranch('feature');
    await waitFor('the master change to leave the list', () => pendingAt(api, path()) === undefined);
    const result = await api.model.keepFile(file.id);

    assert.equal(result.ok, false);
    assert.equal(store().readEntry(file.id)?.base?.toString(), BEFORE);
  });
});
