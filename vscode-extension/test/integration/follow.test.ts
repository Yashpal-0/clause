import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';
import {
  extensionApi,
  inWorkspace,
  open,
  reset,
  seedCreated,
  seedEdited,
  seedEditedElsewhere,
  sleep,
  store,
  waitFor,
} from './helpers.ts';

// Claude changed line 2 and added a line at the end: blocks start at lines 1 and 4.
const BEFORE = 'one\ntwo\nthree\nfour\n';
const AFTER = 'one\nTWO\nthree\nfour\nfive\n';

// Short, so that the suite stays fast; the real values are tuned for a person at a keyboard.
const SETTLE_MS = 150;
const TYPING_IDLE_MS = 1500;

const idOf = (path: string) => store().idFor(path);
const setting = () => vscode.workspace.getConfiguration('claudePending');

describe('opening the file Claude has just edited', () => {
  let api: ExtensionApi;
  let defaults: ExtensionApi['follow']['timing'];
  let tools = 0;
  /** Every file that became visible, in order: a later preview tab replaces an earlier one, so looking afterwards misses it. */
  let shown: string[];
  let watching: vscode.Disposable;

  async function following(on: boolean): Promise<void> {
    await setting().update('followEdits', on, vscode.ConfigurationTarget.Global);
    await waitFor(`the setting to read ${on}`, () => setting().get('followEdits') === on);
  }

  const editorFor = (path: string) =>
    vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file' && idOf(editor.document.uri.fsPath) === idOf(path));

  const inView = (path: string, line: number) =>
    editorFor(path)?.visibleRanges.some((range) => range.start.line <= line && line <= range.end.line) === true;

  const cursorLine = (path: string) => editorFor(path)?.selection.active.line;

  /** What the hook does after an edit: the entry exists, then the record of the edit is written. */
  function claudeEdited(path: string, line: number): void {
    assert.ok(store().touch(idOf(path), { tool: `toolu_${++tools}`, line }));
  }

  const waitForEditor = (path: string) => waitFor(`${path} to be shown`, () => editorFor(path) !== undefined);

  before(async () => {
    api = await extensionApi();
    defaults = { ...api.follow.timing };
    await following(true);
  });
  after(async () => {
    Object.assign(api.follow.timing, defaults);
    // The other test files run with it off; `undefined` would bring back the manifest's default of on.
    await following(false);
  });
  beforeEach(() => {
    api.follow.timing.settleMs = SETTLE_MS;
    // Off, so that the typing of one test does not hold back the next; the test about typing turns it on.
    api.follow.timing.typingIdleMs = 0;
    shown = [];
    watching = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) if (editor.document.uri.scheme === 'file' && !shown.includes(editor.document.uri.fsPath)) shown.push(editor.document.uri.fsPath);
    });
  });
  afterEach(async () => {
    watching.dispose();
    await reset(api);
  });

  it('opens a file whose entry has no record of the edit at its first block, as a preview tab', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);

    await waitForEditor(path);
    await waitFor('the cursor on the first block', () => cursorLine(path) === 1);
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((candidate) => candidate.input instanceof vscode.TabInputText && idOf(candidate.input.uri.fsPath) === idOf(path));
    assert.equal(tab?.isPreview, true);
  });

  it('opens a file at the block the edit started in', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(path, 4);

    await waitForEditor(path);
    await waitFor('the cursor on the second block', () => cursorLine(path) === 4);
  });

  it('opens a file Claude created at its first line', async () => {
    const path = seedCreated('new.txt', 'hello\nworld\n');
    claudeEdited(path, 0);

    await waitForEditor(path);
    await waitFor('the cursor on the first line', () => cursorLine(path) === 0);
  });

  it('leaves the cursor where it is when the new edit is already in view', async () => {
    const path = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(path, 1);
    await waitFor('the cursor on the first block', () => cursorLine(path) === 1);

    claudeEdited(path, 4);
    await sleep(SETTLE_MS + 500);

    assert.equal(cursorLine(path), 1);
  });

  it('moves to the block of a later edit when that block is out of view', async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}`);
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((line, index) => (index === 2 || index === 250 ? line.toUpperCase() : line)).join('\n')}\n`;
    const path = seedEdited('long.txt', before, after);
    claudeEdited(path, 250);

    await waitFor('the cursor on the block at line 250, in view', () => cursorLine(path) === 250 && inView(path, 250));

    claudeEdited(path, 2);
    await waitFor('the cursor on the block at line 2, in view', () => cursorLine(path) === 2 && inView(path, 2));
  });

  it('opens only the newest of the edits that come within the settle time', async () => {
    api.follow.timing.settleMs = 800;
    const first = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(first, 1);
    await sleep(250);
    const second = seedEdited('b.txt', BEFORE, AFTER);
    claudeEdited(second, 1);

    await waitForEditor(second);
    await sleep(300);

    assert.deepEqual(shown.map(idOf), [idOf(second)]);
  });

  it('waits until you have stopped typing, then opens the file', async () => {
    api.follow.timing.typingIdleMs = TYPING_IDLE_MS;
    const draft = inWorkspace('typing/draft.txt');
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(draft, 'hello\n');
    const typing = await open(draft);
    await typing.edit((edit) => edit.insert(new vscode.Position(0, 0), 'x'));
    const typedAt = Date.now();

    const path = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(path, 1);
    await sleep(TYPING_IDLE_MS / 2);
    assert.equal(editorFor(path), undefined, 'not while you are typing');

    await waitForEditor(path);
    assert.ok(Date.now() - typedAt >= TYPING_IDLE_MS - 200, `opened ${Date.now() - typedAt} ms after the typing`);
  });

  it('does not follow a file outside the folders this window has open', async () => {
    const outside = seedEditedElsewhere('a.txt', BEFORE, AFTER);
    claudeEdited(outside, 1);
    await sleep(SETTLE_MS + 500);
    assert.deepEqual(shown, [], 'not the file elsewhere');

    // The control: the same edit inside the folder is followed, so the silence above was the file's place.
    const inside = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(inside, 1);
    await waitForEditor(inside);
    assert.deepEqual(shown.map(idOf), [idOf(inside)]);
  });

  it('follows nothing while the setting is off, whether it was turned off before the edit or after it', async () => {
    await following(false);
    const early = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(early, 1);
    await sleep(SETTLE_MS + 500);
    assert.deepEqual(shown, [], 'off before the edit');

    await following(true);
    api.follow.timing.settleMs = 800;
    const late = seedEdited('b.txt', BEFORE, AFTER);
    claudeEdited(late, 1);
    await sleep(300);
    await following(false);
    await sleep(1000);
    assert.deepEqual(shown, [], 'off after the edit');

    await following(true);
    api.follow.timing.settleMs = SETTLE_MS;
    const control = seedEdited('c.txt', BEFORE, AFTER);
    claudeEdited(control, 1);
    await waitForEditor(control);
    assert.deepEqual(shown.map(idOf), [idOf(control)]);
  });

  it('does not open a file that is compared as a whole, and still follows the next one', async () => {
    const binary = seedEdited('data.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    claudeEdited(binary, 0);
    await sleep(SETTLE_MS + 500);
    assert.deepEqual(shown, [], 'not the binary file');

    const text = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(text, 1);
    await waitForEditor(text);
    assert.deepEqual(shown.map(idOf), [idOf(text)]);
  });

  it('does not open a file that has nothing left to decide', async () => {
    const settled = seedEdited('a.txt', BEFORE, BEFORE);
    claudeEdited(settled, 1);
    await sleep(SETTLE_MS + 500);
    assert.deepEqual(shown, [], 'not the settled file');

    const text = seedEdited('b.txt', BEFORE, AFTER);
    claudeEdited(text, 1);
    await waitForEditor(text);
    assert.deepEqual(shown.map(idOf), [idOf(text)]);
  });

  it('does nothing for an entry that is gone when the follow runs, and still follows the next one', async () => {
    api.follow.timing.settleMs = 600;
    const gone = seedEdited('a.txt', BEFORE, AFTER);
    claudeEdited(gone, 1);
    await sleep(200);
    store().removeEntry(idOf(gone));
    await sleep(900);
    assert.deepEqual(shown, [], 'not the removed entry');

    const text = seedEdited('b.txt', BEFORE, AFTER);
    claudeEdited(text, 1);
    await waitForEditor(text);
    assert.deepEqual(shown.map(idOf), [idOf(text)]);
  });
});
