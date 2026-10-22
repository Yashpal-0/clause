import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension.ts';
import { assertOk, blockTarget, extensionApi, onlyPendingFile, open, pendingAt, read, storedBaseline, waitFor } from '../helpers.ts';
import { BEFORE, restartFile } from './shared.ts';

// The second of two runs: a new editor process on the workspace, user data and store the first run left behind.
// The tests build on each other and run in this order; the last one changes the file.
describe('after the editor is opened again with changes still pending', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });

  it('shows the same three blocks, found in the store and the file', async () => {
    assert.ok(existsSync(restartFile()), 'the first run has not happened: run restart-seed and restart-reopen in one vscode-test invocation');
    const file = await onlyPendingFile(api);

    assert.equal(file.id, pendingAt(api, restartFile())?.id);
    assert.deepEqual(
      file.state.blocks.map((block) => block.kind),
      ['changed', 'changed', 'added'],
    );
    await waitFor('the count', () => api.summary.text === '$(diff) Claude: 3 pending · 1 file');
  });

  it('still counts the typing as a block: the baseline is the one from before Claude\'s first edit', async () => {
    const file = await onlyPendingFile(api);

    assert.equal(storedBaseline(restartFile()), BEFORE);
    assert.equal(api.model.baselineOf(file.id), BEFORE);
    // The typing is on line 5 (index 4). The blocks are lines 2, 5 and 8, as half-open ranges of line indexes.
    assert.deepEqual(
      file.state.blocks.map((block) => [block.curStart, block.curEnd]),
      [
        [1, 2],
        [4, 5],
        [7, 8],
      ],
    );
  });

  it('puts the bar and the tints back on the file when it is opened', async () => {
    await onlyPendingFile(api);
    const editor = await open(restartFile());
    await waitFor('the editor to refuse the proposal', () => api.insets.unavailable);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri);

    assert.deepEqual(
      lenses.filter((lens) => lens.command?.command === 'claudePending.keepBlock').map((lens) => lens.range.start.line),
      [1, 4, 7],
    );
    await waitFor('the tints', () => api.decorations.appliedTo(editor)?.added.length === 3);
    assert.deepEqual(
      api.decorations.appliedTo(editor)!.added.map(({ startLine, endLine }) => [startLine, endLine]),
      [
        [1, 1],
        [4, 4],
        [7, 7],
      ],
    );
  });

  it('lets the user discard a block, and leaves the other two alone', async () => {
    const file = await onlyPendingFile(api);

    assertOk(await vscode.commands.executeCommand('claudePending.discardBlock', blockTarget(file, 0)));

    assert.equal(read(restartFile()), 'one\ntwo\nthree\nfour\nmy five\nsix\nseven\neight\n');
    assert.equal(storedBaseline(restartFile()), BEFORE);
    await waitFor('the other two blocks', () => api.model.files()[0]?.state.blocks.length === 2);
  });
});
