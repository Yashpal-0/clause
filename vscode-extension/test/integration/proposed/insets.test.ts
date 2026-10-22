import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension.ts';
import { BASELINE_SCHEME } from '../../../src/ui/diff.ts';
import { MAX_BLOCKS_WITH_INSETS } from '../../../src/ui/insets.ts';
import { assertOk, blockTarget, extensionApi, onlyPendingFile, open, read, reset, seedEdited, storedBaseline, waitFor } from '../helpers.ts';

// Claude changed line 2 and added a line at the end.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// This configuration starts the editor with --enable-proposed-api for the extension, as the README sets it up.
describe('the inline view, where the editor allows the editorInsets proposal', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  const kinds = () => api.model.files()[0]?.state.blocks.map((block) => block.kind);
  const drawn = (editor: vscode.TextEditor) => api.insets.inspect(editor);

  /** Opens the file once the model knows it and waits for `count` insets in the editor. */
  async function openWithInsets(path: string, count: number): Promise<vscode.TextEditor> {
    await onlyPendingFile(api);
    const editor = await open(path);
    await waitFor(`${count} insets`, () => drawn(editor).length === count);
    return editor;
  }

  const lensesOf = (editor: vscode.TextEditor) => vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri);

  it('draws the lines a block replaced as rows above its new lines, and its bar below them', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', BEFORE, AFTER), 3);

    assert.equal(api.insets.unavailable, false);
    assert.deepEqual(
      drawn(editor).map(({ item }) => [item.afterLine, item.rows, item.bar]),
      [
        // TWO replaced two: the old line above the new one, the bar on the row below it.
        [0, ['two'], false],
        [1, [], true],
        // five is new: only a bar, on the row below it.
        [4, [], true],
      ],
    );
    assert.deepEqual(
      drawn(editor).map(({ counter }) => counter),
      [undefined, '1 of 2', '2 of 2'],
    );
    const [rows, replacedBar, addedBar] = drawn(editor);
    assert.match(rows!.html, /<div class="row">two<\/div>/);
    assert.doesNotMatch(rows!.html, /data-action/, 'the rows have no buttons');
    assert.match(replacedBar!.html, /data-action="keep"/);
    assert.doesNotMatch(replacedBar!.html, /class="rows"/, 'the bar has no rows of its own');
    assert.match(addedBar!.html, /class="bar-row added"/, 'the bar under new lines has their green');
    assert.deepEqual(await lensesOf(editor), [], 'no CodeLens repeats what the insets already show');
  });

  it('closes the rows of a block that only removed lines with its bar, which stays plain', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', 'one\ntwo\nthree\n', 'one\nthree\n'), 1);

    const [only] = drawn(editor);
    assert.deepEqual([only!.item.afterLine, only!.item.rows, only!.item.bar, only!.counter], [0, ['two'], true, '1 of 1']);
    assert.match(only!.html, /<div class="row">two<\/div>/);
    assert.match(only!.html, /data-action="keep"/);
    assert.match(only!.html, /class="bar-row"/);
  });

  it('puts the removed lines above the first line for a block that starts there', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', 'a\nb\n', 'x\nb\n'), 2);

    assert.deepEqual(
      drawn(editor).map(({ item }) => [item.afterLine, item.bar]),
      [
        [-1, false],
        [0, true],
      ],
    );
  });

  it('puts the bar below lines added at the top', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', 'a\nb\n', 'x\na\nb\n'), 1);

    assert.deepEqual(drawn(editor).map(({ item }) => [item.afterLine, item.bar]), [[0, true]]);
  });

  it('stands in for the CodeLens and the red marker of the block it is drawn for', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', 'one\ntwo\nthree\n', 'one\nthree\n'), 1);

    assert.deepEqual(await lensesOf(editor), []);
    await waitFor('the red marker to give way to the inset', () => api.decorations.appliedTo(editor)?.removed.length === 0);
  });

  it('moves the bar under the rows when the new lines of a block are deleted', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'), 2);
    assert.deepEqual(drawn(editor).map(({ item }) => item.bar), [false, true]);

    await editor.edit((edit) => edit.delete(new vscode.Range(1, 0, 2, 0)));

    await waitFor('one inset with the rows and the bar', () => {
      const now = drawn(editor);
      return now.length === 1 && now[0]!.item.bar && now[0]!.item.rows.join() === 'two';
    });
    assert.match(drawn(editor)[0]!.html, /data-action="keep"/);
  });

  it('leaves the other insets as they are when one block is kept, and renumbers them', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const editor = await openWithInsets(path, 3);
    const [, , third] = drawn(editor);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock', blockTarget(file, 0)));

    await waitFor('both insets of the first block to go', () => drawn(editor).length === 1);
    const [only] = drawn(editor);
    assert.equal(only!.counter, '1 of 1');
    assert.equal(only!.html, third!.html, 'the page of a block that stays is not rebuilt');
  });

  it('draws the insets of at most MAX_BLOCKS_WITH_INSETS blocks and leaves the CodeLens to the rest', async () => {
    // Every other line changed: 20 blocks, one line each, and each has an inset for its old line and one for its bar.
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((line, index) => (index % 2 === 0 ? line.toUpperCase() : line)).join('\n')}\n`;
    const path = seedEdited('many.txt', before, after);
    assert.equal((await onlyPendingFile(api)).state.blocks.length, 20);
    const editor = await openWithInsets(path, 2 * MAX_BLOCKS_WITH_INSETS);

    assert.equal(drawn(editor).at(-1)!.counter, `${MAX_BLOCKS_WITH_INSETS} of 20`);
    const lenses = await lensesOf(editor);
    assert.deepEqual(
      lenses.filter((lens) => lens.command?.command === 'clause.keepBlock').map((lens) => lens.range.start.line),
      Array.from({ length: 20 - MAX_BLOCKS_WITH_INSETS }, (_, index) => 2 * (MAX_BLOCKS_WITH_INSETS + index)),
    );
  });

  describe('a click on the bar', () => {
    it('keeps the block of its own inset', async () => {
      const path = seedEdited('a.txt', BEFORE, AFTER);
      const editor = await openWithInsets(path, 3);

      await api.insets.deliver(editor, 2, { type: 'keep' });

      assert.equal(storedBaseline(path), 'one\ntwo\nthree\nfour\nfive\n');
      assert.equal(read(path), AFTER);
      assert.deepEqual(kinds(), ['changed']);
    });

    it('discards the block of its own inset', async () => {
      const path = seedEdited('a.txt', BEFORE, AFTER);
      const editor = await openWithInsets(path, 3);

      await api.insets.deliver(editor, 1, { type: 'discard' });

      assert.equal(editor.document.getText(), 'one\ntwo\nthree\nfour\nfive\n');
      assert.equal(storedBaseline(path), BEFORE);
      assert.deepEqual(kinds(), ['added']);
      await waitFor('the other inset to take the first place', () => drawn(editor).map(({ counter }) => counter).join() === '1 of 1');
    });

    it('moves the cursor to the next and the previous block, wrapping around at the ends', async () => {
      const editor = await openWithInsets(seedEdited('a.txt', BEFORE, AFTER), 3);
      const cursorLine = () => editor.selection.active.line;

      await api.insets.deliver(editor, 1, { type: 'next' });
      assert.equal(cursorLine(), 4, 'the added line');
      await api.insets.deliver(editor, 2, { type: 'next' });
      assert.equal(cursorLine(), 1, 'back to the first block');
      await api.insets.deliver(editor, 1, { type: 'previous' });
      assert.equal(cursorLine(), 4, 'back to the last block');
    });

    it('ignores anything that is not one of the four actions', async () => {
      const path = seedEdited('a.txt', BEFORE, AFTER);
      const editor = await openWithInsets(path, 3);
      const pages = drawn(editor).map(({ html }) => html);

      for (const message of [undefined, null, 'keep', 42, {}, { kind: 'keep' }, { type: 'KEEP' }, { type: 'keepAll' }, { type: ['keep'] }]) {
        await api.insets.deliver(editor, 1, message);
      }

      assert.equal(read(path), AFTER);
      assert.equal(storedBaseline(path), BEFORE);
      assert.deepEqual(kinds(), ['changed', 'added']);
      assert.deepEqual(
        drawn(editor).map(({ html }) => html),
        pages,
      );
    });
  });

  it('gives a line added above the blocks a bar of its own, and moves the other insets down with their blocks', async () => {
    const editor = await openWithInsets(seedEdited('a.txt', BEFORE, AFTER), 3);

    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'zero\n'));

    // The file has pending blocks, so the typed line is a block too: new line 0 gets a bar, and each old inset moves one down.
    await waitFor('the insets to follow their blocks', () => drawn(editor).map(({ item }) => item.afterLine).join() === '0,1,2,5');
    assert.deepEqual(
      drawn(editor).map(({ item }) => item.rows),
      [[], ['two'], [], []],
    );
    assert.deepEqual(
      drawn(editor).map(({ counter }) => counter),
      ['1 of 3', undefined, '2 of 3', '3 of 3'],
    );
  });

  it('draws nothing in a diff editor, which already marks what changed', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const plain = await openWithInsets(path, 3);
    const baseline = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: file.uri.path, query: file.id });
    // VS Code gives the sides of a diff editor no column; the extension keeps insets out of them by that.
    const modifiedSide = () => vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file' && editor.viewColumn === undefined);

    await vscode.commands.executeCommand('vscode.diff', baseline, file.uri, 'diff', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });

    await waitFor('the diff editor', () => modifiedSide() !== undefined);
    api.insets.reconcile();
    assert.deepEqual(drawn(modifiedSide()!), []);
    assert.equal(drawn(plain).length, 3, 'the editor beside it keeps its insets');
  });

  it('draws the insets in every editor that shows the file', async () => {
    const left = await openWithInsets(seedEdited('a.txt', BEFORE, AFTER), 3);

    const right = await vscode.window.showTextDocument(left.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });

    await waitFor('the second editor to get its insets', () => drawn(right).length === 3);
    assert.equal(drawn(left).length, 3);
  });

  it('goes with the editor and comes back with the next one', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const first = await openWithInsets(path, 3);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('the insets to go with their editor', () => drawn(first).length === 0);

    await openWithInsets(path, 3);
  });

  it('is gone once nothing in the file is pending', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);
    const editor = await openWithInsets(path, 3);

    assertOk(await vscode.commands.executeCommand('clause.keepFile', { kind: 'file', id: file.id }));

    await waitFor('the insets to go', () => drawn(editor).length === 0);
  });
});
