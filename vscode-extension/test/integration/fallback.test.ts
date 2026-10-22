import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { extensionApi, onlyPendingFile, open, reset, seedEdited, waitFor } from './helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// This configuration starts the editor without --enable-proposed-api, as an editor nobody has set up.
describe('the CodeLens view, where the editor has not allowed the editorInsets proposal', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  /** Opens the file once the model knows it, and waits until the extension has found out that no inset can be drawn. */
  async function openWithoutInsets(path: string): Promise<vscode.TextEditor> {
    await onlyPendingFile(api);
    const editor = await open(path);
    await waitFor('the editor to refuse the proposal', () => api.insets.unavailable);
    return editor;
  }

  it('finds out on its own and draws no inset', async () => {
    const editor = await openWithoutInsets(seedEdited('a.txt', BEFORE, AFTER));

    assert.deepEqual(api.insets.inspect(editor), []);
  });

  it('shows the whole bar as CodeLens above each block', async () => {
    const editor = await openWithoutInsets(seedEdited('a.txt', BEFORE, AFTER));

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri);

    const titles = (command: string) => lenses.filter((lens) => lens.command?.command === command).map((lens) => lens.command?.title);
    assert.deepEqual(titles('claudePending.keepBlock'), ['$(check) Keep Ctrl+Y', '$(check) Keep Ctrl+Y']);
    assert.deepEqual(titles('claudePending.discardBlock'), ['$(discard) Discard Ctrl+N', '$(discard) Discard Ctrl+N']);
    assert.equal(titles('claudePending.reveal').length, 4, 'an arrow each way, for each of the two blocks');
    assert.equal(titles('claudePending.openDiff').length, 2);
  });

  it('still marks the place where lines were removed', async () => {
    const editor = await openWithoutInsets(seedEdited('a.txt', 'one\ntwo\nthree\n', 'one\nthree\n'));

    await waitFor('the marker', () => api.decorations.appliedTo(editor)?.removed.length === 1);
  });
});
