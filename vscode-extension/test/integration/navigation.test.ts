import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { blockTarget, extensionApi, fileTarget, inWorkspace, onlyPendingFile, open, reset, seedEdited, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end: the blocks start at lines 1 and 4 (zero-based).
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

describe('moving between blocks', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** Runs `command` `times` times and lists the line the cursor was on after each. */
  async function stops(editor: vscode.TextEditor, command: string, times: number): Promise<number[]> {
    const lines: number[] = [];
    for (let step = 0; step < times; step++) {
      await vscode.commands.executeCommand(command);
      lines.push(editor.selection.active.line);
    }
    return lines;
  }

  async function openChanged(): Promise<vscode.TextEditor> {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);
    return open(path);
  }

  it('goes to the next block, and from the last one round to the first', async () => {
    const editor = await openChanged();

    assert.deepEqual(await stops(editor, 'clause.nextBlock', 3), [1, 4, 1]);
  });

  it('goes to the previous block, and from the first one round to the last', async () => {
    const editor = await openChanged();

    assert.deepEqual(await stops(editor, 'clause.previousBlock', 3), [4, 1, 4]);
  });

  it('does nothing in a file Claude has not changed', async () => {
    const path = inWorkspace('plain.txt');
    writeFileSync(path, 'a\nb\nc\n');
    const editor = await open(path);
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    await vscode.commands.executeCommand('clause.nextBlock');
    await vscode.commands.executeCommand('clause.previousBlock');

    assert.equal(editor.selection.active.line, 2);
  });
});

describe('revealing a pending change', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  it('opens the file at a block, with the cursor on its first line', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    await vscode.commands.executeCommand('clause.reveal', blockTarget(file, 1));

    await waitFor('the cursor to reach the block', () => vscode.window.activeTextEditor?.selection.active.line === 4);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), vscode.Uri.file(path).toString());
  });

  it('opens a file Claude changed', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    await vscode.commands.executeCommand('clause.reveal', fileTarget(file));

    await waitFor('the file to open', () => vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.file(path).toString());
  });

  it('ignores a target that is not a file or a block', async () => {
    seedEdited('a.txt', BEFORE, AFTER);
    await onlyPendingFile(api);

    await vscode.commands.executeCommand('clause.reveal', { kind: 'group' });
    await vscode.commands.executeCommand('clause.reveal', { kind: 'file', id: '0'.repeat(64) });
    await vscode.commands.executeCommand('clause.reveal', 'a.txt');

    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 0, 'nothing was opened');
  });
});
