import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import { assertOk, blockTarget, extensionApi, fileTarget, inWorkspace, onlyPendingFile, open, pendingAt, reset, seedEdited, sleep, waitFor } from './helpers.ts';

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

  it('opens a file Claude changed in a preview tab, with the cursor on its first change, as clicking a file in Cursor does', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    const file = await onlyPendingFile(api);

    await vscode.commands.executeCommand('clause.reveal', fileTarget(file));

    await waitFor('the file to open', () => vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.file(path).toString());
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, 1, 'the first change is on the second line');
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, true);
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

describe('going on to the next change once one is kept or discarded', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await extensionApi();
  });
  afterEach(() => reset(api));

  // Claude added two lines after the first (a block at lines 1-2, zero-based) and changed lines 5 and 8.
  const BEFORE_THREE = 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n';
  const AFTER_THREE = 'l0\nadd-a\nadd-b\nl1\nl2\nL3\nl4\nl5\nL6\nl7\n';

  async function openChanged(before = BEFORE_THREE, after = AFTER_THREE): Promise<vscode.TextEditor> {
    const path = seedEdited('a.txt', before, after);
    await onlyPendingFile(api);
    return open(path);
  }

  const cursorAt = (editor: vscode.TextEditor, line: number, character = 0) => {
    editor.selection = new vscode.Selection(line, character, line, character);
  };

  /**
   * The editor tells the extension where the cursor was after each move, a moment late, so a read straight after
   * two moves in a row can show the first. Waiting for the line is how a test sees where the cursor ends up.
   */
  const cursorGoesTo = (editor: vscode.TextEditor, line: number) =>
    waitFor(`the cursor to reach line ${line}`, () => editor.selection.active.line === line);

  it('moves the cursor to what was the next change when a change is kept', async () => {
    const editor = await openChanged();
    cursorAt(editor, 1);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock'));

    await cursorGoesTo(editor, 5);
  });

  it('moves the cursor to what was the next change when a change is discarded, though the lines moved up', async () => {
    const editor = await openChanged();
    cursorAt(editor, 1);

    assertOk(await vscode.commands.executeCommand('clause.discardBlock'));

    assert.equal(editor.document.getText().startsWith('l0\nl1\nl2\nL3'), true, 'the two added lines are gone');
    await cursorGoesTo(editor, 3); // the change that was at line 5
  });

  it('goes to the first change left when the last one of the file was kept', async () => {
    const editor = await openChanged();
    cursorAt(editor, 8);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock'));

    await cursorGoesTo(editor, 1);
  });

  it('goes to the first change left when the last one of the file was discarded', async () => {
    const editor = await openChanged();
    cursorAt(editor, 8);

    assertOk(await vscode.commands.executeCommand('clause.discardBlock'));

    await cursorGoesTo(editor, 1);
  });

  it('goes on from the change that was settled, and not from the cursor, when its bar is clicked from elsewhere', async () => {
    const editor = await openChanged();
    const file = await onlyPendingFile(api);
    cursorAt(editor, 0);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock', blockTarget(file, 1)));

    // The change below the one that was kept. The cursor was above all of them, so going on from the cursor would give line 1.
    await cursorGoesTo(editor, 8);
  });

  it('lands right when changes are settled one after the other, and moves nothing for the last one', async () => {
    const editor = await openChanged();
    cursorAt(editor, 1);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock'));
    await cursorGoesTo(editor, 5);
    assertOk(await vscode.commands.executeCommand('clause.keepBlock'));
    await cursorGoesTo(editor, 8);
    cursorAt(editor, 8, 1);
    await sleep(100);
    assertOk(await vscode.commands.executeCommand('clause.keepBlock'));
    await sleep(200);

    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [8, 1]);
    await waitFor('the file to be settled', () => api.model.files().length === 0);
  });

  it('does not move the editor when a change of another file is kept, as a click in the panel does', async () => {
    const other = seedEdited('other.txt', BEFORE_THREE, AFTER_THREE);
    const shown = await open(seedEdited('shown.txt', BEFORE_THREE, AFTER_THREE));
    await waitFor('both files', () => api.model.files().length === 2);
    const file = pendingAt(api, other)!;
    cursorAt(shown, 8, 1);

    assertOk(await vscode.commands.executeCommand('clause.keepBlock', blockTarget(file, 0)));
    await sleep(200);

    assert.equal(vscode.window.activeTextEditor, shown);
    assert.deepEqual([shown.selection.active.line, shown.selection.active.character], [8, 1]);
  });

  it('leaves the selection alone when selected lines are kept', async () => {
    const editor = await openChanged();
    editor.selection = new vscode.Selection(5, 0, 6, 0);

    assertOk(await vscode.commands.executeCommand('clause.keepSelection'));
    await sleep(200);

    assert.deepEqual(
      [editor.selection.start.line, editor.selection.end.line],
      [5, 6],
    );
  });

  it('gives up quietly, and leaves the cursor, when the model does not show the change gone', async () => {
    const editor = await openChanged();
    const stale = api.model.files()[0]!;
    cursorAt(editor, 1, 1);
    // The model keeps answering with the file as it was before the keep: its next state never arrives.
    (api.model as { fileById: unknown }).fileById = () => stale;
    const started = Date.now();
    try {
      assertOk(await vscode.commands.executeCommand('clause.keepBlock'));
    } finally {
      delete (api.model as { fileById?: unknown }).fileById;
    }

    assert.ok(Date.now() - started >= 900, 'it waited for the model for about a second');
    assert.ok(Date.now() - started < 5000, 'and then stopped waiting');
    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [1, 1]);
  });
});
